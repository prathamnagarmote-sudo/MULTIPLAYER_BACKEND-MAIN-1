import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

@Injectable()
export class PortManagerService implements OnModuleInit {
  private readonly logger = new Logger(PortManagerService.name);
  private readonly portStart: number;
  private readonly portEnd: number;
  private readonly usedPorts = new Set<number>();

  constructor(private readonly configService: ConfigService) {
    this.portStart = this.configService.get<number>(
      'gameServers.portStart',
      7900,
    );
    this.portEnd = this.configService.get<number>('gameServers.portEnd', 8900);

    if (this.portEnd < this.portStart) {
      throw new Error(
        `Invalid game server port range: ${this.portStart}-${this.portEnd}`,
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.syncExistingContainerPorts();
  }

  reservePort(): number {
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }

    throw new Error('No available ports for new game server containers');
  }

  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  getCapacity(): number {
    return this.portEnd - this.portStart + 1;
  }

  getCurrentLoad(): { used: number; total: number } {
    return {
      used: this.usedPorts.size,
      total: this.getCapacity(),
    };
  }

  private async syncExistingContainerPorts(): Promise<void> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'ps',
        '--filter',
        'name=stacknize-match-',
        '--format',
        '{{json .Ports}}',
      ]);

      const portLines = stdout
        .trim()
        .split('\n')
        .filter((line) => line);

      for (const portJson of portLines) {
        try {
          const ports: unknown = JSON.parse(portJson);
          const hostPort = this.extractHostPort(ports);

          if (
            hostPort &&
            hostPort >= this.portStart &&
            hostPort <= this.portEnd
          ) {
            this.usedPorts.add(hostPort);
            this.logger.debug(
              `Pre-reserved port ${hostPort} for existing container`,
            );
          }
        } catch {
          this.logger.warn(`Failed to parse Docker port info: ${portJson}`);
        }
      }

      this.logger.log(
        `Synced ${this.usedPorts.size} ports from existing Docker containers`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to sync existing container ports: ${this.getErrorMessage(error)}. Proceeding with empty port tracking.`,
      );
    }
  }

  private extractHostPort(ports: unknown): number | null {
    if (typeof ports === 'string') {
      const match = ports.match(/(\d+)->\d+\/tcp/);
      if (match) {
        return parseInt(match[1], 10);
      }
    } else if (Array.isArray(ports)) {
      for (const port of ports) {
        if (port && typeof port === 'object' && 'HostPort' in port) {
          const hostPort = (port as Record<string, unknown>).HostPort;
          if (typeof hostPort === 'string' || typeof hostPort === 'number') {
            return parseInt(String(hostPort), 10);
          }
        }
      }
    }

    return null;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
