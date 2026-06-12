import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateEventDto {
  @ApiPropertyOptional({
    description: 'New event title.',
    example: 'Open Air Concert (Rescheduled)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiPropertyOptional({
    description: 'New event description.',
    example: 'Updated line-up and timing.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'New event start date/time as an ISO-8601 instant. Must be in the future.',
    example: '2030-02-01T20:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  @IsFutureDate()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'New total seat capacity. Whole integer between 1 and 1,000,000.',
    minimum: 1,
    maximum: 1_000_000,
    example: 300,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalSeats?: number;
}
