import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SpawnGameServerDto {
  @ApiProperty({
    description: 'Unique match identifier used to track the container',
    example: 'f16cb7cb-6cb9-4eb9-9fb8-5d2bc7d8b3e1',
  })
  @IsString()
  @MinLength(1)
  matchId!: string;

  @ApiProperty({
    description: 'Game type or game key for the spawned server',
    example: 'Game_2_Carrom',
  })
  @IsString()
  @MinLength(1)
  gameType!: string;
}
