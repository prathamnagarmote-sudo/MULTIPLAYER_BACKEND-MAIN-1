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

@Injectable()
export class GameServerWebSocketRouterService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(GameServerWebSocketRouterService.name);
  private readonly routerPort: number;
  private readonly httpServer = createServer();
  private readonly proxy = httpProxy.createProxyServer({ ws: true });

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
    this.httpServer.close();
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    const matchId = this.extractMatchId(request.url ?? '');
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

    if (!matchId) {
      this.logger.warn(`Could not extract match ID from URL: ${request.url}`);
      this.rejectUpgrade(socket, 404, 'Invalid match path');
      return;
    }

    const match = this.gameServersService.getActiveMatch(matchId);

    if (!match) {
      this.logger.warn(`Match not found: ${matchId}`);
      this.rejectUpgrade(socket, 404, 'Match not found');
      return;
    }

    this.logger.debug(
      `Forwarding WebSocket to ${match.upstreamHost}:${match.upstreamPort} for match ${matchId}`,
    );

    this.proxy.ws(request, socket, head, {
      target: `ws://${match.upstreamHost}:${match.upstreamPort}`,
      changeOrigin: true,
      ws: true,
    });
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
