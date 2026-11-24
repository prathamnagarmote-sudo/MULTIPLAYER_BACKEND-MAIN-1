import {
  Controller,
  Post,
  Req,
  Res,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Controller('scores')
export class ScoresController {
  private readonly logger = new Logger(ScoresController.name);

  private readonly skillifyWebhookUrl =
    process.env.SKILLIFY_WEBHOOK_URL ||
    process.env.SKILLIFY_SETTLEMENT_WEBHOOK ||
    'https://skillify-gaming-plattform.vercel.app/api/v1/tournaments/submitMultiplayerScore';

  private readonly primaryPlatformScoreUrl =
    process.env.PRIMARY_PLATFORM_SCORE_URL ||
    'https://replayhub.faecomtech.com/api/scores/submit';

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  async submitScore(@Req() req: Request, @Res() res: Response): Promise<void> {
    const rawBody = req.body || {};
    const bodyStr =
      typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);

    const matchId =
      rawBody.matchId ||
      rawBody.match_id ||
      rawBody.sessionId ||
      rawBody.session_id ||
      rawBody.tournamentId ||
      rawBody.tournament_id ||
      '';

    const isSkillifyMatch =
      bodyStr.toLowerCase().includes('skillify') ||
      String(matchId).toLowerCase().includes('skillify');

    if (isSkillifyMatch) {
      this.logger.log(
        `[Conditional Proxy] Routing match '${matchId}' to Skillify webhook (${this.skillifyWebhookUrl})`,
      );

      try {
        const upstreamResponse = await fetch(this.skillifyWebhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: bodyStr,
        });

        const data = await upstreamResponse.text();
        this.logger.log(
          `[Skillify Webhook] Upstream status=${upstreamResponse.status} for match '${matchId}'`,
        );

        res.status(upstreamResponse.status).send(data);
      } catch (error) {
        this.logger.error(
          `[Skillify Webhook Error] Failed to forward score for match '${matchId}': ${(error as Error).message}`,
        );
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: (error as Error).message,
        });
      }
    } else {
      this.logger.log(
        `[Conditional Proxy] Routing match '${matchId}' to Primary Platform (${this.primaryPlatformScoreUrl})`,
      );

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Host: 'replayhub.faecomtech.com',
        };

        if (req.headers['authorization']) {
          headers['Authorization'] = String(req.headers['authorization']);
        }
        if (req.headers['x-internal-auth']) {
          headers['X-Internal-Auth'] = String(req.headers['x-internal-auth']);
        }

        const upstreamResponse = await fetch(this.primaryPlatformScoreUrl, {
          method: 'POST',
          headers,
          body: bodyStr,
        });

        const data = await upstreamResponse.text();
        this.logger.log(
          `[Primary Platform] Upstream status=${upstreamResponse.status} for match '${matchId}'`,
        );

        res.status(upstreamResponse.status).send(data);
      } catch (error) {
        this.logger.error(
          `[Primary Platform Error] Failed to forward score for match '${matchId}': ${(error as Error).message}`,
        );
        res.status(HttpStatus.BAD_GATEWAY).json({
          success: false,
          error: (error as Error).message,
        });
      }
    }
  }
}
