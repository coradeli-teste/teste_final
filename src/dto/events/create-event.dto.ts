import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { IsFutureDate } from '../validators/is-future-date.validator';

export class CreateEventDto {
  @ApiProperty({
    description: 'Event title.',
    example: 'Open Air Concert',
  })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({
    description: 'Optional event description.',
    example: 'An evening of live music in the park.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Event start date/time as an ISO-8601 instant. Must be in the future.',
    example: '2030-01-01T20:00:00.000Z',
  })
  @IsISO8601()
  @IsFutureDate()
  startDate!: string;

  @ApiProperty({
    description: 'Total seat capacity. Whole integer between 1 and 1,000,000.',
    minimum: 1,
    maximum: 1_000_000,
    example: 250,
  })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalSeats!: number;
}
