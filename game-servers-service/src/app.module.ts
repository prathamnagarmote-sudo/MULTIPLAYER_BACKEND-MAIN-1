import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

// App
import { AppController } from './app.controller';
import { AppService } from './app.service';

// Config
import { appConfig, gameServersConfig } from './config';

// Modules
import { GameServersModule } from './modules/game-servers';

@Module({
  imports: [
    // Global configuration with organized config files
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, gameServersConfig],
    }),

    // Feature modules
    GameServersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
