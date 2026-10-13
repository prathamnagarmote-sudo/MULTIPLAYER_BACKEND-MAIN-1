import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class BindGameServerRouteDto {
  @ApiProperty({
    description:
      'Nakama match identifier that clients may use to reach the match',
    example: 'f16cb7cb-6cb9-4eb9-9fb8-5d2bc7d8b3e1',
  })
  @IsString()
  @MinLength(1)
  matchId!: string;

  @ApiProperty({
    description:
      'Spawned Unity server identifier used internally by the backend',
    example: 'b5a1b4f6-7f64-4c1f-a9be-2b1b7d49a1ce',
  })
  @IsString()
  @MinLength(1)
  serverMatchId!: string;
}
