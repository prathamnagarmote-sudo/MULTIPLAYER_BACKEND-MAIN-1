import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class StopGameServerDto {
  @ApiProperty({
    description: 'Unique match identifier whose container should be stopped',
    example: 'f16cb7cb-6cb9-4eb9-9fb8-5d2bc7d8b3e1',
  })
  @IsString()
  @MinLength(1)
  matchId!: string;
}
