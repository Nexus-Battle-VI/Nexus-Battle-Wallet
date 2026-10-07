import { ApiProperty } from '@nestjs/swagger'
import { Equals, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator'

export class CreditTournamentPrizeDto {
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^\S(?:.*\S)?$/)
  operationId!: string
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^\S(?:.*\S)?$/)
  tournamentId!: string
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^\S(?:.*\S)?$/)
  championTeamId!: string
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^\S(?:.*\S)?$/)
  finalEncounterId!: string
  @ApiProperty({ type: String, nullable: true, maxLength: 160 })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^\S(?:.*\S)?$/)
  finalRoomId!: string | null
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^\S(?:.*\S)?$/)
  playerId!: string
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^\S(?:.*\S)?$/)
  heroId!: string
  @ApiProperty({ enum: ['CREDITS'] }) @Equals('CREDITS') kind!: 'CREDITS'
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,15}$',
    description: 'Máximo 9007199254740991; validación semántica exacta.',
  })
  @IsString()
  amount!: string
  @ApiProperty({ type: String, nullable: true, enum: [null] }) @Equals(null) productId!: null
}

export class TournamentPrizeReceiptDto extends CreditTournamentPrizeDto {
  @ApiProperty({ enum: ['DELIVERED'] }) status!: 'DELIVERED'
  @ApiProperty({ type: String, format: 'uuid' }) receiptId!: string
}
