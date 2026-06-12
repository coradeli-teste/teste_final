import { ApiProperty } from '@nestjs/swagger';
import type { EntityStatus } from '../../common/types';

export class EventView {
  @ApiProperty({
    description: 'Event identifier (UUID v4).',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  id!: string;

  @ApiProperty({ description: 'Event title.', example: 'Open Air Concert' })
  title!: string;

  @ApiProperty({
    description: 'Event description.',
    nullable: true,
    example: 'An evening of live music in the park.',
  })
  description!: string | null;

  @ApiProperty({
    description: 'Event start date/time as an ISO-8601 instant.',
    example: '2030-01-01T20:00:00.000Z',
  })
  startDate!: string;

  @ApiProperty({ description: 'Total seat capacity.', example: 250 })
  totalSeats!: number;

  @ApiProperty({ description: 'Seats still available.', example: 0 })
  remainingSeats!: number;

  @ApiProperty({
    description: 'Lifecycle status of the event.',
    enum: ['active', 'cancelled'],
    example: 'active',
  })
  status!: EntityStatus;

  @ApiProperty({
    description: 'True when an active event has no remaining seats.',
    example: true,
  })
  soldOut!: boolean;
}
