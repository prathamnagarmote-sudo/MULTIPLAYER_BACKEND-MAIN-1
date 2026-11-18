import { Module } from '@nestjs/common';
import { GameServersController } from './game-servers.controller';
import { ScoresController } from './scores.controller';
import { GameServersService } from './game-servers.service';
import { PortManagerService } from './port-manager.service';
import { GameServerWebSocketRouterService } from './ws-router.service';

@Module({
  controllers: [GameServersController, ScoresController],
  providers: [
    GameServersService,
    PortManagerService,
    GameServerWebSocketRouterService,
  ],
  exports: [
    GameServersService,
    PortManagerService,
    GameServerWebSocketRouterService,
  ],
})
export class GameServersModule {}
