import { ApiProperty } from '@nestjs/swagger';
import type { EntityStatus } from '../../common/types';

export class ReservationHistoryEntry {
  @ApiProperty({
    description: 'Reservation identifier (UUID v4).',
    example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  })
  reservationId!: string;

  @ApiProperty({
    description: 'Identifier of the event the reservation belongs to (UUID v4).',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  eventId!: string;

  @ApiProperty({
    description: "The user's participation status for this reservation.",
    enum: ['active', 'cancelled'],
    example: 'active',
  })
  participationStatus!: EntityStatus;

  @ApiProperty({
    description: 'Snapshot of the associated event status.',
    enum: ['active', 'cancelled'],
    example: 'cancelled',
  })
  eventStatus!: EntityStatus;
}
