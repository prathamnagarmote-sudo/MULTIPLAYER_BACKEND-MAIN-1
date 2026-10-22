import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STATUS_CODES, createServer } from 'http';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import httpProxy from 'http-proxy';
import { GameServersService } from './game-servers.service';

interface TrackedMatchState {
  matchId: string;
  spawnedAt: number;
  hasEstablishedSession: boolean;
  activeSockets: Set<Socket>;
  destroyTimer?: NodeJS.Timeout;
  startupTimer?: NodeJS.Timeout;
}

/**
 * Container lifecycle rules (enforced by socket tracking):
 *
 * 1. STARTUP GRACE PERIOD (45s):
 *    When a match is spawned, WebGL clients need time to download assets,
 *    unpack scenes, and establish their connection (plus handle retries up to 7 x 3s).
 *    During this 45s window, the container is NEVER killed on momentary 0-socket disconnects.
 *    If nobody connects within 45s, the orphan container is cleaned up.
 *
 * 2. ESTABLISHED GAME / SCORECARD:
 *    Once players connect and remain for >= 5s, the session is marked "established".
 *    While in-game OR sitting on the Scorecard (waiting for Rematch), the container stays alive.
 *
 * 3. INSTANT DESTRUCTION ON EXIT (2s):
 *    When ALL players click "Home" / "Exit" (or when Unity's 30s Scorecard rematch timer
 *    expires and disconnects all clients), active sockets drop to 0.
 *    The container is destroyed within 2s, freeing RAM and CPU instantly.
 *
 * 4. MULTIPLAYER SCALING (2P & 4P):
 *    As long as >= 1 player remains in the game or scorecard, the container stays alive.
 *    Only when the final remaining player leaves does the 2s destruction timer fire.
 */
@Injectable()
export class GameServerWebSocketRouterService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(GameServerWebSocketRouterService.name);
  private readonly routerPort: number;
  private readonly httpServer = createServer();
  private readonly proxy = httpProxy.createProxyServer({ ws: true });

  /**
   * Tracked state per canonical match ID.
   */
  private readonly trackedMatches = new Map<string, TrackedMatchState>();

  /**
   * Stagger queue per match ID to prevent SimpleWebTransport (Unity) handshake collisions.
   */
  private readonly matchHandshakeQueues = new Map<string, Promise<void>>();

  /**
   * Delay before destroying container once ALL players leave an established game / scorecard.
   * Small enough to be instant from the user's perspective, but prevents race conditions.
   */
  private static readonly IMMEDIATE_STOP_MS = 2_000; // 2 seconds

  /**
   * Startup Grace Period (45 seconds):
   * Protects the container from being prematurely destroyed during WebGL loading
   * and initial connection negotiation retries.
   */
  private static readonly STARTUP_GRACE_PERIOD_MS = 45_000; // 45 seconds

  /**
   * Minimum active connection duration before a session is considered "established".
   */
  private static readonly ESTABLISHED_SESSION_THRESHOLD_MS = 5_000; // 5 seconds

  constructor(
    private readonly gameServersService: GameServersService,
    configService: ConfigService,
  ) {
    this.routerPort = configService.get<number>('gameServers.routerPort', 4000);
  }

  onModuleInit(): void {
    this.httpServer.on('request', (request, response) => {
      const url = request.url ?? '';
      this.logger.warn(
        `Received non-WebSocket request on router port ${this.routerPort}: ${request.method ?? 'GET'} ${url}`,
      );

      response.statusCode = 426;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Connection', 'close');
      response.end('WebSocket upgrade required');
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket as Socket, head);
    });

    this.proxy.on('error', (error, request, socket) => {
      const requestUrl =
        request && 'url' in request ? String(request.url ?? '') : '';
      this.logger.error(
        `WebSocket proxy error on port ${this.routerPort} for ${requestUrl || 'unknown request'}: ${this.getErrorMessage(error)}`,
      );

      if (socket && typeof (socket as Socket).destroy === 'function') {
        (socket as Socket).destroy();
      }
    });

    this.proxy.on('proxyReq', (proxyReq, req) => {
      this.logger.debug(
        `WebSocket proxy forwarding: ${req.method} ${req.url} -> upgrade=${req.headers.upgrade}, connection=${req.headers.connection}`,
      );
    });

    this.httpServer.on('error', (error) => {
      this.logger.error(
        `WebSocket router server error on port ${this.routerPort}: ${this.getErrorMessage(error)}`,
      );
    });

    this.httpServer.listen(this.routerPort, '0.0.0.0', () => {
      this.logger.log(
        `Game server websocket router listening on port ${this.routerPort}`,
      );
    });

    this.logger.log(
      `GameServerWebSocketRouterService initialized (port ${this.routerPort})`,
    );
  }

  onModuleDestroy(): void {
    for (const state of this.trackedMatches.values()) {
      if (state.destroyTimer) clearTimeout(state.destroyTimer);
      if (state.startupTimer) clearTimeout(state.startupTimer);
    }
    this.trackedMatches.clear();
    this.matchHandshakeQueues.clear();
    this.httpServer.close();
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    const rawMatchId = this.extractMatchId(request.url ?? '');
    const upgradeHeader = (request.headers.upgrade ?? '').toLowerCase();

    this.logger.debug(
      `WebSocket upgrade request: method=${request.method} url=${request.url} upgrade=${upgradeHeader} connection=${request.headers.connection}`,
    );

    if (upgradeHeader !== 'websocket') {
      this.logger.warn(
        `Invalid upgrade header: expected 'websocket', got '${upgradeHeader}'`,
      );
      this.rejectUpgrade(socket, 426, 'WebSocket upgrade required');
      return;
    }

    if (!rawMatchId) {
      this.logger.warn(`Could not extract match ID from URL: ${request.url}`);
      this.rejectUpgrade(socket, 404, 'Invalid match path');
      return;
    }

    const match = this.gameServersService.getActiveMatch(rawMatchId);

    if (!match) {
      this.logger.warn(`Match not found: ${rawMatchId}`);
      this.rejectUpgrade(socket, 404, 'Match not found');
      return;
    }

    const canonicalMatchId = match.matchId;

    // ── Get or create match tracking state ─────────────────────────────────
    let state = this.trackedMatches.get(canonicalMatchId);
    if (!state) {
      state = {
        matchId: canonicalMatchId,
        spawnedAt: match.startedAt.getTime(),
        hasEstablishedSession: false,
        activeSockets: new Set<Socket>(),
      };
      this.trackedMatches.set(canonicalMatchId, state);

      // Arm startup guard timer for abandoned containers
      state.startupTimer = setTimeout(() => {
        if (!state?.hasEstablishedSession && state?.activeSockets.size === 0) {
          this.logger.warn(
            `[match ${canonicalMatchId}] Startup grace period expired with 0 active players. Destroying container...`,
          );
          void this.destroyContainer(canonicalMatchId);
        }
      }, GameServerWebSocketRouterService.STARTUP_GRACE_PERIOD_MS);
    }

    // ── Cancel any pending destruction timer ──────────────────────────────
    this.cancelDestroyTimer(canonicalMatchId, 'incoming player connection');

    // ── Register socket ───────────────────────────────────────────────────
    state.activeSockets.add(socket);
    const activeCount = state.activeSockets.size;
    this.logger.log(
      `[match ${canonicalMatchId}] Player connected. Active sockets: ${activeCount}`,
    );

    // ── Establish Session Timer ───────────────────────────────────────────
    // If the socket remains connected for 5s, mark the match as established.
    const establishTimer = setTimeout(() => {
      if (state && state.activeSockets.has(socket)) {
        if (!state.hasEstablishedSession) {
          state.hasEstablishedSession = true;
          if (state.startupTimer) {
            clearTimeout(state.startupTimer);
            state.startupTimer = undefined;
          }
          this.logger.log(
            `[match ${canonicalMatchId}] Game session established with ${state.activeSockets.size} active player(s).`,
          );
        }
      }
    }, GameServerWebSocketRouterService.ESTABLISHED_SESSION_THRESHOLD_MS);

    // ── Disconnect handler ────────────────────────────────────────────────
    let cleanedUp = false;
    const cleanupSocket = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(establishTimer);

      const currentState = this.trackedMatches.get(canonicalMatchId);
      if (!currentState) return;

      currentState.activeSockets.delete(socket);
      const remaining = currentState.activeSockets.size;
      this.logger.log(
        `[match ${canonicalMatchId}] Player disconnected. Remaining sockets: ${remaining}`,
      );

      if (remaining === 0) {
        if (currentState.hasEstablishedSession) {
          // Both/all players left established game or scorecard -> destroy in 2s
          this.logger.warn(
            `[match ${canonicalMatchId}] All players disconnected from established game. ` +
              `Scheduling container destruction in ${GameServerWebSocketRouterService.IMMEDIATE_STOP_MS / 1000}s...`,
          );

          currentState.destroyTimer = setTimeout(() => {
            void this.destroyContainer(canonicalMatchId);
          }, GameServerWebSocketRouterService.IMMEDIATE_STOP_MS);
        } else {
          // Socket disconnected during initial startup / handshake
          const elapsedSinceSpawn = Date.now() - currentState.spawnedAt;
          if (
            elapsedSinceSpawn <
            GameServerWebSocketRouterService.STARTUP_GRACE_PERIOD_MS
          ) {
            const remainingGrace = Math.round(
              (GameServerWebSocketRouterService.STARTUP_GRACE_PERIOD_MS -
                elapsedSinceSpawn) /
                1000,
            );
            this.logger.log(
              `[match ${canonicalMatchId}] Sockets dropped to 0 during startup phase. ` +
                `Protected by startup grace period (${remainingGrace}s remaining for client retries).`,
            );
            // Do NOT kill the container. Retries will connect or startupTimer will clean up.
          } else {
            this.logger.warn(
              `[match ${canonicalMatchId}] All sockets disconnected and startup grace period expired. Scheduling container destruction in 2s...`,
            );
            currentState.destroyTimer = setTimeout(() => {
              void this.destroyContainer(canonicalMatchId);
            }, GameServerWebSocketRouterService.IMMEDIATE_STOP_MS);
          }
        }
      }
    };

    socket.once('close', cleanupSocket);
    socket.once('error', cleanupSocket);

    // ── Proxy the WebSocket with Handshake Staggering ─────────────────────
    // SimpleWebTransport (Unity) has a concurrent handshake race condition:
    // when multiple players connect at the exact same millisecond, simultaneous
    // handshakes corrupt the internal handshake state resulting in:
    // "Invalid Sec-WebSocket-Accept header".
    // Staggering upstream connections by 120ms ensures serialized,
    // clean handshakes for 2-player and 4-player matches.
    const delayMs = 120;
    const currentQueue =
      this.matchHandshakeQueues.get(canonicalMatchId) ?? Promise.resolve();
    const nextQueue = currentQueue
      .catch(() => {})
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    this.matchHandshakeQueues.set(canonicalMatchId, nextQueue);

    currentQueue.then(() => {
      if (socket.destroyed || !socket.readable) {
        return;
      }

      this.logger.debug(
        `Forwarding WebSocket to ${match.upstreamHost}:${match.upstreamPort} for match ${canonicalMatchId}`,
      );

      this.proxy.ws(request, socket, head, {
        target: `ws://${match.upstreamHost}:${match.upstreamPort}`,
        changeOrigin: true,
        ws: true,
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private cancelDestroyTimer(canonicalMatchId: string, reason: string): void {
    const state = this.trackedMatches.get(canonicalMatchId);
    if (state?.destroyTimer) {
      clearTimeout(state.destroyTimer);
      state.destroyTimer = undefined;
      this.logger.log(
        `[match ${canonicalMatchId}] Cancelled destruction timer (reason: ${reason})`,
      );
    }
  }

  private async destroyContainer(canonicalMatchId: string): Promise<void> {
    const state = this.trackedMatches.get(canonicalMatchId);
    if (state && state.activeSockets.size > 0) {
      this.logger.log(
        `[match ${canonicalMatchId}] Destruction cancelled — ${state.activeSockets.size} socket(s) reconnected before timer fired.`,
      );
      if (state.destroyTimer) {
        clearTimeout(state.destroyTimer);
        state.destroyTimer = undefined;
      }
      return;
    }

    if (state) {
      if (state.destroyTimer) clearTimeout(state.destroyTimer);
      if (state.startupTimer) clearTimeout(state.startupTimer);
      this.trackedMatches.delete(canonicalMatchId);
      this.matchHandshakeQueues.delete(canonicalMatchId);
    }

    // Verify match is still active before attempting to stop
    const match = this.gameServersService.getActiveMatch(canonicalMatchId);
    if (!match) {
      this.logger.debug(
        `[match ${canonicalMatchId}] Container already stopped or not active.`,
      );
      return;
    }

    try {
      this.logger.log(
        `[match ${canonicalMatchId}] Destroying container now...`,
      );
      await this.gameServersService.stopServer(canonicalMatchId);
      this.logger.log(
        `[match ${canonicalMatchId}] Container destroyed successfully.`,
      );
    } catch (err) {
      this.logger.error(
        `[match ${canonicalMatchId}] Failed to destroy container: ${this.getErrorMessage(err)}`,
      );
    }
  }

  private rejectUpgrade(
    socket: Socket,
    statusCode: number,
    message: string,
  ): void {
    const statusText = STATUS_CODES[statusCode] ?? 'Error';
    const body = Buffer.from(message, 'utf8');

    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n` +
        '\r\n',
    );
    socket.write(body);
    socket.destroy();
  }

  private extractMatchId(url: string): string | null {
    const match = url.match(/^\/match\/([^/?#]+)/);

    if (!match) {
      return null;
    }

    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
