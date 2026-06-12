import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { AuthUser, EntityStatus } from '../common/types';
import { ReservationHistoryEntry } from '../dto';

interface EventReservationRow {
  id: string;
  status: string;
  start_date: string;
  remaining_seats: number;
}

interface ReservationCancelRow {
  id: string;
  user_id: string;
  event_id: string;
  status: string;
}

@Injectable()
export class ReservationsService {
  constructor(private readonly database: DatabaseService) {}

  reserve(
    user: AuthUser,
    eventId: string,
  ): { reservationId: string; remainingSeats: number } {
    return this.database.transaction(() => {
      const event = this.database.get<EventReservationRow>(
        'SELECT id, status, start_date, remaining_seats FROM events WHERE id = ?',
        [eventId],
      );

      if (!event) {
        throw new NotFoundException('Event not found.');
      }

      if (event.status === 'cancelled') {
        throw new ConflictException('Event has been cancelled.');
      }

      const startMs = Date.parse(event.start_date);
      if (!Number.isNaN(startMs) && startMs <= Date.now()) {
        throw new BadRequestException(
          'Event has already started; reservations are closed.',
        );
      }

      const duplicate = this.database.get<{ one: number }>(
        `SELECT 1 AS one FROM reservations
          WHERE user_id = ? AND event_id = ? AND status = 'active'`,
        [user.id, eventId],
      );

      if (duplicate) {
        throw new ConflictException(
          'An active reservation for this event already exists.',
        );
      }

      const decrement = this.database.run(
        `UPDATE events
            SET remaining_seats = remaining_seats - 1
          WHERE id = ? AND status = 'active' AND remaining_seats > 0`,
        [eventId],
      );

      if (decrement.changes === 0) {
        throw new ConflictException('Event is sold out.');
      }

      const reservationId = uuidv4();
      const now = new Date().toISOString();
      this.database.run(
        `INSERT INTO reservations (
           id, user_id, event_id, status, event_status_snapshot,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'active', 'active', ?, ?)`,
        [reservationId, user.id, eventId, now, now],
      );

      return {
        reservationId,
        remainingSeats: event.remaining_seats - 1,
      };
    });
  }

  cancel(user: AuthUser, reservationId: string): void {
    this.database.transaction(() => {
      const reservation = this.database.get<ReservationCancelRow>(
        'SELECT id, user_id, event_id, status FROM reservations WHERE id = ?',
        [reservationId],
      );

      if (!reservation) {
        throw new NotFoundException('Reservation not found.');
      }

      if (reservation.user_id !== user.id) {
        throw new ForbiddenException(
          'You can only cancel your own reservations.',
        );
      }

      if (reservation.status === 'cancelled') {
        throw new ConflictException('Reservation is already cancelled.');
      }

      const now = new Date().toISOString();

      this.database.run(
        `UPDATE reservations
            SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND status = 'active'`,
        [now, reservationId],
      );

      this.database.run(
        `UPDATE events
            SET remaining_seats = MIN(remaining_seats + 1, total_seats),
                updated_at = ?
          WHERE id = ?`,
        [now, reservation.event_id],
      );
    });
  }

  propagateEventCancellation(eventId: string): void {
    const now = new Date().toISOString();
    this.database.run(
      `UPDATE reservations
          SET event_status_snapshot = 'cancelled', updated_at = ?
        WHERE event_id = ?`,
      [now, eventId],
    );
  }

  history(user: AuthUser): ReservationHistoryEntry[] {
    const rows = this.database.all<{
      id: string;
      event_id: string;
      status: EntityStatus;
      event_status_snapshot: EntityStatus;
    }>(
      `SELECT id, event_id, status, event_status_snapshot
         FROM reservations
        WHERE user_id = ?
        ORDER BY created_at ASC`,
      [user.id],
    );

    return rows.map((row) => ({
      reservationId: row.id,
      eventId: row.event_id,
      participationStatus: row.status,
      eventStatus: row.event_status_snapshot,
    }));
  }
}
