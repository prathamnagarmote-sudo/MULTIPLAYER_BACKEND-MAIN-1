import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import net from 'net';
import { promisify } from 'util';
import { PortManagerService } from './port-manager.service';

const execFileAsync = promisify(execFile);

export interface ActiveGameServer {
  matchId: string;
  gameType: string;
  hostPort: number;
  upstreamHost: string;
  upstreamPort: number;
  containerId: string;
  containerName: string;
  startedAt: Date;
}

export interface SpawnGameServerResult {
  matchPath: string;
  alreadyRunning: boolean;
}

@Injectable()
export class GameServersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameServersService.name);
  private readonly activeMatches = new Map<string, ActiveGameServer>();
  private readonly routeAliases = new Map<string, string>();
  private readonly containerImage: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly bootTimeoutSeconds: number;
  private readonly internalPort: number;
  private readonly dockerNetwork: string;
  private readonly cleanupIntervalSeconds: number;
  private readonly maxMatchLifetimeMinutes: number;
  private readonly internalHookSecret: string;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupInProgress = false;

  constructor(
    private readonly portManager: PortManagerService,
    configService: ConfigService,
  ) {
    this.containerImage = configService.get<string>('gameServers.image', '');
    this.memoryLimit = configService.get<string>(
      'gameServers.memoryLimit',
      '400m',
    );
    this.cpuLimit = configService.get<string>('gameServers.cpuLimit', '0.5');
    this.bootTimeoutSeconds = configService.get<number>(
      'gameServers.bootTimeoutSeconds',
      60,
    );
    this.internalPort = configService.get<number>(
      'gameServers.internalPort',
      7778,
    );
    this.dockerNetwork = configService.get<string>(
      'gameServers.dockerNetwork',
      'stacknize-game-net',
    );
    this.cleanupIntervalSeconds = configService.get<number>(
      'gameServers.cleanupIntervalSeconds',
      30,
    );
    this.maxMatchLifetimeMinutes = configService.get<number>(
      'gameServers.maxMatchLifetimeMinutes',
      180,
    );
    this.internalHookSecret = configService.get<string>(
      'gameServers.internalHookSecret',
      '',
    );
  }

  onModuleInit(): void {
    const intervalMs = Math.max(5, this.cleanupIntervalSeconds) * 1000;

    this.cleanupTimer = setInterval(() => {
      void this.runCleanupCycle();
    }, intervalMs);
    this.cleanupTimer.unref();

    this.logger.log(
      `Game server cleanup enabled: interval=${Math.max(5, this.cleanupIntervalSeconds)}s maxLifetime=${Math.max(10, this.maxMatchLifetimeMinutes)}m`,
    );

    void this.runCleanupCycle();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async spawnServer(
    matchId: string,
    gameType: string,
  ): Promise<SpawnGameServerResult> {
    if (!this.containerImage.trim()) {
      throw new ServiceUnavailableException(
        'GAME_SERVER_IMAGE is not configured. Set it to the Unity headless server image before spawning matches.',
      );
    }

    const existingMatch = this.activeMatches.get(matchId);
    if (existingMatch) {
      this.logger.warn(
        `Spawn request ignored because match already exists: ${matchId}`,
      );
      return { matchPath: `/match/${matchId}`, alreadyRunning: true };
    }

    const containerName = this.buildContainerName(matchId);
    const maxAttempts = this.portManager.getCapacity();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const hostPort = this.portManager.reservePort();

      try {
        if (!(await this.isHostPortAvailable(hostPort))) {
          this.logger.warn(
            `Skipping occupied host port ${hostPort} for match ${matchId}`,
          );
          this.portManager.releasePort(hostPort);
          continue;
        }

        const { stdout } = await execFileAsync('docker', [
          'run',
          '-d',
          '--name',
          containerName,
          '--restart',
          'no',
          '--memory',
          this.memoryLimit,
          '--cpus',
          this.cpuLimit,
          '--network',
          this.dockerNetwork,
          '--label',
          'stacknize.managed=true',
          '--label',
          `stacknize.match_id=${matchId}`,
          '--label',
          `stacknize.started_at=${Date.now()}`,
          '-p',
          `${hostPort}:${this.internalPort}/tcp`,
          '-e',
          `MATCH_ID=${matchId}`,
          '-e',
          `GAME_TYPE=${gameType}`,
          '-e',
          `INTERNAL_HOOK_SECRET=${this.internalHookSecret}`,
          this.containerImage,
        ]);

        const containerId = stdout.trim();
        if (!containerId) {
          throw new ServiceUnavailableException(
            `Docker did not return a container id for match ${matchId}`,
          );
        }

        const connectionTarget = {
          targetHost: containerName,
          targetPort: this.internalPort,
        };

        this.logger.debug(
          `Using Docker DNS target ${connectionTarget.targetHost}:${connectionTarget.targetPort} on network ${this.dockerNetwork}`,
        );

        await this.waitForContainerReady(
          connectionTarget.targetHost,
          connectionTarget.targetPort,
        );

        this.activeMatches.set(matchId, {
          matchId,
          gameType,
          hostPort,
          upstreamHost: connectionTarget.targetHost,
          upstreamPort: connectionTarget.targetPort,
          containerId,
          containerName,
          startedAt: new Date(),
        });

        this.logger.log(
          `Spawned game server matchId=${matchId} port=${hostPort} upstream=${connectionTarget.targetHost}:${connectionTarget.targetPort} container=${containerId.slice(0, 12)}`,
        );

        return { matchPath: `/match/${matchId}`, alreadyRunning: false };
      } catch (error) {
        const bindConflict = this.isPortBindConflict(error);

        await this.cleanupFailedSpawn(containerName, hostPort);

        if (bindConflict) {
          this.logger.warn(
            `Port ${hostPort} was claimed during spawn for match ${matchId}; retrying with another port`,
          );
          continue;
        }

        throw this.toServiceUnavailable(
          error,
          `Failed to spawn game server for match ${matchId}`,
        );
      }
    }

    throw new ServiceUnavailableException(
      'No available ports for new game server containers',
    );
  }

  async stopServer(matchId: string): Promise<void> {
    const resolvedMatchId = this.resolveMatchId(matchId);
    const match = this.activeMatches.get(resolvedMatchId);

    if (!match) {
      throw new NotFoundException(
        `No active game server found for matchId ${matchId}`,
      );
    }

    this.logger.log(`Stopping game server for matchId=${matchId}`);

    await this.removeContainerAndState(match, resolvedMatchId, 'stop-request');
  }

  private async runCleanupCycle(): Promise<void> {
    if (this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;

    try {
      await this.cleanupExpiredActiveMatches();
      await this.cleanupExitedManagedContainers();
      await this.cleanupExpiredManagedOrphans();
    } catch (error) {
      this.logger.warn(
        `Background game server cleanup failed: ${this.getErrorMessage(error)}`,
      );
    } finally {
      this.cleanupInProgress = false;
    }
  }

  private async cleanupExpiredActiveMatches(): Promise<void> {
    const now = Date.now();
    const maxLifetimeMs =
      Math.max(10, this.maxMatchLifetimeMinutes) * 60 * 1000;

    for (const [matchId, match] of this.activeMatches.entries()) {
      if (now - match.startedAt.getTime() <= maxLifetimeMs) {
        continue;
      }

      this.logger.warn(
        `Auto-stopping match ${matchId} because it exceeded max lifetime (${Math.max(10, this.maxMatchLifetimeMinutes)}m)`,
      );

      await this.removeContainerAndState(
        match,
        matchId,
        'max-lifetime-exceeded',
      );
    }
  }

  private async cleanupExitedManagedContainers(): Promise<void> {
    const containerIds = await this.listManagedContainerIds(['exited', 'dead']);

    if (containerIds.length === 0) {
      return;
    }

    await execFileAsync('docker', ['rm', '-f', ...containerIds]);

    for (const containerId of containerIds) {
      this.removeStateByContainerId(containerId);
    }
  }

  private async cleanupExpiredManagedOrphans(): Promise<void> {
    const containerIds = await this.listManagedContainerIds(['running']);

    if (containerIds.length === 0) {
      return;
    }

    const maxLifetimeMs =
      Math.max(10, this.maxMatchLifetimeMinutes) * 60 * 1000;
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{.Id}}\t{{.Name}}\t{{index .Config.Labels "stacknize.started_at"}}',
      ...containerIds,
    ]);

    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const now = Date.now();
    for (const line of lines) {
      const [containerId, inspectedName, startedAtRaw] = line.split('\t');

      if (!containerId || !startedAtRaw) {
        continue;
      }

      if (this.hasTrackedContainer(containerId)) {
        continue;
      }

      const startedAtMs = Number(startedAtRaw);
      if (!Number.isFinite(startedAtMs) || now - startedAtMs <= maxLifetimeMs) {
        continue;
      }

      const containerName = inspectedName?.startsWith('/')
        ? inspectedName.slice(1)
        : inspectedName || containerId.slice(0, 12);

      this.logger.warn(
        `Removing orphaned managed container ${containerName} after max lifetime exceeded`,
      );

      try {
        await execFileAsync('docker', ['rm', '-f', containerId]);
      } catch (error) {
        this.logger.warn(
          `Failed to remove orphaned container ${containerName}: ${this.getErrorMessage(error)}`,
        );
      }
    }
  }

  private async listManagedContainerIds(statuses: string[]): Promise<string[]> {
    const args = ['ps', '-aq', '--filter', 'label=stacknize.managed=true'];

    for (const status of statuses) {
      args.push('--filter', `status=${status}`);
    }

    const { stdout } = await execFileAsync('docker', args);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private hasTrackedContainer(containerId: string): boolean {
    const idPrefix = containerId.slice(0, 12);

    for (const match of this.activeMatches.values()) {
      if (
        match.containerId === containerId ||
        match.containerId.startsWith(idPrefix) ||
        containerId.startsWith(match.containerId)
      ) {
        return true;
      }
    }

    return false;
  }

  private removeStateByContainerId(containerId: string): void {
    const idPrefix = containerId.slice(0, 12);

    for (const [matchId, match] of this.activeMatches.entries()) {
      if (
        match.containerId === containerId ||
        match.containerId.startsWith(idPrefix) ||
        containerId.startsWith(match.containerId)
      ) {
        this.portManager.releasePort(match.hostPort);
        this.activeMatches.delete(matchId);
        this.removeRouteAliasesForMatch(matchId);
      }
    }
  }

  private async removeContainerAndState(
    match: ActiveGameServer,
    resolvedMatchId: string,
    reason: string,
  ): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', match.containerName]);
    } catch (error) {
      this.logger.error(
        `Docker removal failed for ${match.containerName}: ${this.getErrorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        `Failed to stop game server container for matchId ${resolvedMatchId}: ${this.getErrorMessage(error)}`,
      );
    }

    this.logger.log(
      `Removed game server container for matchId=${resolvedMatchId} reason=${reason}`,
    );

    this.portManager.releasePort(match.hostPort);
    this.activeMatches.delete(resolvedMatchId);
    this.removeRouteAliasesForMatch(resolvedMatchId);
  }

  bindMatchRoute(matchId: string, serverMatchId: string) {
    const match = this.activeMatches.get(serverMatchId);

    if (!match) {
      throw new NotFoundException(
        `No active game server found for serverMatchId ${serverMatchId}`,
      );
    }

    this.routeAliases.set(matchId, serverMatchId);
  }

  getActiveMatch(matchId: string): ActiveGameServer | undefined {
    const resolvedMatchId = this.resolveMatchId(matchId);
    return this.activeMatches.get(resolvedMatchId);
  }

  private async cleanupFailedSpawn(
    containerName: string,
    hostPort: number,
  ): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName]);
    } catch {
      // Ignore cleanup errors; the important part is releasing the port.
    }

    this.portManager.releasePort(hostPort);
  }

  private resolveMatchId(matchId: string): string {
    return this.routeAliases.get(matchId) ?? matchId;
  }

  private removeRouteAliasesForMatch(matchId: string): void {
    for (const [alias, resolvedMatchId] of this.routeAliases.entries()) {
      if (resolvedMatchId === matchId) {
        this.routeAliases.delete(alias);
      }
    }
  }

  private async isHostPortAvailable(hostPort: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = net.createServer();

      probe.unref();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => {
        probe.close(() => resolve(true));
      });

      probe.listen({ port: hostPort, host: '0.0.0.0', exclusive: true });
    });
  }

  private isPortBindConflict(error: unknown): boolean {
    const message = this.getErrorMessage(error).toLowerCase();

    return (
      (message.includes('bind for') ||
        message.includes('failed to set up container networking')) &&
      message.includes('port is already allocated')
    );
  }

  private async waitForContainerReady(
    targetHost: string,
    targetPort: number,
  ): Promise<void> {
    const maxAttempts = Math.max(1, this.bootTimeoutSeconds);
    this.logger.debug(
      `Starting readiness probe for ${targetHost}:${targetPort} with ${maxAttempts} second(s) timeout`,
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(targetPort, targetHost);
        const finish = (isReady: boolean) => {
          socket.destroy();
          resolve(isReady);
        };

        socket.setTimeout(1000);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
      });

      if (ready) {
        this.logger.log(
          `Container ready on ${targetHost}:${targetPort} after ${attempt + 1} attempt(s)`,
        );
        return;
      }

      if ((attempt + 1) % 5 === 0) {
        this.logger.warn(
          `Container probe still waiting on ${targetHost}:${targetPort} (${attempt + 1}/${maxAttempts} seconds)`,
        );
      }

      if (attempt + 1 < maxAttempts) {
        await this.delay(1000);
      }
    }

    throw new ServiceUnavailableException(
      `Game server container on ${targetHost}:${targetPort} did not become ready in time after ${maxAttempts}s`,
    );
  }

  private buildContainerName(matchId: string): string {
    const safeMatchId = matchId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    return `stacknize-match-${safeMatchId}`;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  private toServiceUnavailable(
    error: unknown,
    fallbackMessage: string,
  ): ServiceUnavailableException {
    if (error instanceof ServiceUnavailableException) {
      return error;
    }

    return new ServiceUnavailableException(
      `${fallbackMessage}: ${this.getErrorMessage(error)}`,
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
