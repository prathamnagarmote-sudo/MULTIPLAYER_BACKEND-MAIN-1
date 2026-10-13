import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  UnauthorizedException,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ConfigType } from '@nestjs/config';
import { gameServersConfig } from '../../config';
import { SpawnGameServerDto, StopGameServerDto } from './dto';
import { BindGameServerRouteDto } from './dto/bind-game-server-route.dto';
import { GameServersService } from './game-servers.service';

@ApiTags('game-servers')
@Controller('game-servers')
export class GameServersController {
  private readonly logger = new Logger(GameServersController.name);

  constructor(
    private readonly gameServersService: GameServersService,
    @Inject(gameServersConfig.KEY)
    private readonly gameServersSettings: ConfigType<typeof gameServersConfig>,
  ) {}

  private assertInternalHookAuth(
    internalAuthHeader: string | undefined,
    source: string,
  ): void {
    const expectedSecret = this.gameServersSettings.internalHookSecret.trim();
    const providedSecret = (internalAuthHeader || '').trim();

    if (!expectedSecret || providedSecret !== expectedSecret) {
      this.logger.warn(
        `Internal hook auth failed for ${source}; provided=${providedSecret ? 'present' : 'missing'} expected=${expectedSecret ? 'configured' : 'missing'}`,
      );
      throw new UnauthorizedException('Invalid internal hook secret');
    }
  }

  @Post('spawn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Spawn a dedicated Unity mirror container for a match',
  })
  @ApiBody({ type: SpawnGameServerDto })
  @ApiResponse({
    status: 200,
    description: 'Game server container started successfully',
    schema: {
      type: 'object',
      properties: {
        matchPath: {
          type: 'string',
          example: '/match/f16cb7cb-6cb9-4eb9-9fb8-5d2bc7d8b3e1',
        },
        alreadyRunning: {
          type: 'boolean',
          example: false,
        },
      },
    },
  })
  async spawnServer(
    @Headers('x-internal-auth') internalAuthHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Body() body: SpawnGameServerDto,
  ): Promise<{ matchPath: string; alreadyRunning: boolean }> {
    this.assertInternalHookAuth(
      internalAuthHeader,
      `spawn user-agent=${userAgent || 'unknown'}`,
    );
    return this.gameServersService.spawnServer(body.matchId, body.gameType);
  }

  @Post('bind-route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bind a Nakama match id to the spawned Unity server route',
  })
  @ApiBody({ type: BindGameServerRouteDto })
  @ApiResponse({
    status: 200,
    description: 'Game server route bound successfully',
  })
  bindRoute(
    @Headers('x-internal-auth') internalAuthHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Body() body: BindGameServerRouteDto,
  ): { success: boolean } {
    this.assertInternalHookAuth(
      internalAuthHeader,
      `bind-route user-agent=${userAgent || 'unknown'}`,
    );
    this.gameServersService.bindMatchRoute(body.matchId, body.serverMatchId);
    return { success: true };
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop and remove the dedicated Unity mirror container for a match',
  })
  @ApiBody({ type: StopGameServerDto })
  @ApiResponse({
    status: 200,
    description: 'Game server container stopped successfully',
  })
  async stopServer(
    @Headers('x-internal-auth') internalAuthHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Body() body: StopGameServerDto,
  ): Promise<{ success: boolean }> {
    this.assertInternalHookAuth(
      internalAuthHeader,
      `stop user-agent=${userAgent || 'unknown'}`,
    );
    await this.gameServersService.stopServer(body.matchId);
    return { success: true };
  }
}
