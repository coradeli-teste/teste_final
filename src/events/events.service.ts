import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { CreateEventDto, EventView, UpdateEventDto } from '../dto';
import { AuthUser, EventRow, Role } from '../common/types';
import { ReservationsService } from '../reservations/reservations.service';

const MIN_TOTAL_SEATS = 1;
const MAX_TOTAL_SEATS = 1_000_000;

@Injectable()
export class EventsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reservationsService: ReservationsService,
  ) {}

  create(owner: AuthUser, dto: CreateEventDto): EventView {
    if (
      !Number.isInteger(dto.totalSeats) ||
      dto.totalSeats < MIN_TOTAL_SEATS ||
      dto.totalSeats > MAX_TOTAL_SEATS
    ) {
      throw new BadRequestException(
        'Total seat capacity must be a whole integer between 1 and 1,000,000.',
      );
    }

    const startMs = Date.parse(dto.startDate);
    if (Number.isNaN(startMs) || startMs <= Date.now()) {
      throw new BadRequestException(
        'Event start date/time must be in the future.',
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const description = dto.description ?? null;
    const remainingSeats = dto.totalSeats;

    this.database.run(
      `INSERT INTO events (
         id, owner_id, title, description, start_date,
         total_seats, remaining_seats, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        owner.id,
        dto.title,
        description,
        dto.startDate,
        dto.totalSeats,
        dto.totalSeats,
        now,
        now,
      ],
    );

    return {
      id,
      title: dto.title,
      description,
      startDate: dto.startDate,
      totalSeats: dto.totalSeats,
      remainingSeats,
      status: 'active',
      soldOut: remainingSeats === 0,
    };
  }

  update(actor: AuthUser, eventId: string, dto: UpdateEventDto): EventView {
    return this.database.transaction(() => {
      const event = this.database.get<EventRow>(
        `SELECT
           id,
           owner_id        AS ownerId,
           title,
           description,
           start_date      AS startDate,
           total_seats     AS totalSeats,
           remaining_seats AS remainingSeats,
           status,
           created_at      AS createdAt,
           updated_at      AS updatedAt
         FROM events
         WHERE id = ?`,
        [eventId],
      );

      if (!event) {
        throw new NotFoundException('Event not found.');
      }

      const isOwningOrganizer =
        actor.role === Role.ORGANIZER && event.ownerId === actor.id;
      if (!isOwningOrganizer) {
        throw new ForbiddenException(
          'Only the organizer who created the event may update it.',
        );
      }

      if (dto.startDate !== undefined) {
        const startMs = Date.parse(dto.startDate);
        if (Number.isNaN(startMs) || startMs <= Date.now()) {
          throw new BadRequestException(
            'Event start date/time must be in the future.',
          );
        }
      }

      const reserved = this.database.get<{ reservedCount: number }>(
        `SELECT COUNT(*) AS reservedCount
         FROM reservations
         WHERE event_id = ? AND status = 'active'`,
        [eventId],
      );
      const reservedCount = reserved?.reservedCount ?? 0;

      if (dto.totalSeats !== undefined && dto.totalSeats < reservedCount) {
        throw new BadRequestException(
          'New total seat capacity cannot be lower than the number of seats already reserved.',
        );
      }

      const title = dto.title ?? event.title;
      const description =
        dto.description !== undefined ? dto.description : event.description;
      const startDate = dto.startDate ?? event.startDate;
      const totalSeats = dto.totalSeats ?? event.totalSeats;
      const remainingSeats =
        dto.totalSeats !== undefined
          ? totalSeats - reservedCount
          : event.remainingSeats;
      const now = new Date().toISOString();

      this.database.run(
        `UPDATE events
         SET title = ?,
             description = ?,
             start_date = ?,
             total_seats = ?,
             remaining_seats = ?,
             updated_at = ?
         WHERE id = ?`,
        [title, description, startDate, totalSeats, remainingSeats, now, eventId],
      );

      return {
        id: event.id,
        title,
        description,
        startDate,
        totalSeats,
        remainingSeats,
        status: event.status,
        soldOut: remainingSeats === 0,
      };
    });
  }

  cancel(actor: AuthUser, eventId: string): void {
    this.database.transaction(() => {
      const event = this.database.get<EventRow>(
        `SELECT
           id,
           owner_id        AS ownerId,
           title,
           description,
           start_date      AS startDate,
           total_seats     AS totalSeats,
           remaining_seats AS remainingSeats,
           status,
           created_at      AS createdAt,
           updated_at      AS updatedAt
         FROM events
         WHERE id = ?`,
        [eventId],
      );

      if (!event) {
        throw new NotFoundException('Event not found.');
      }

      const isAdministrator = actor.role === Role.ADMINISTRATOR;
      const isOwningOrganizer =
        actor.role === Role.ORGANIZER && event.ownerId === actor.id;
      if (!isAdministrator && !isOwningOrganizer) {
        throw new ForbiddenException(
          'Only the owning organizer or an administrator may cancel the event.',
        );
      }

      if (event.status === 'cancelled') {
        throw new ConflictException('Event is already cancelled.');
      }

      const now = new Date().toISOString();

      this.database.run(
        `UPDATE events
         SET status = 'cancelled',
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
        [now, eventId],
      );

      this.reservationsService.propagateEventCancellation(eventId);
    });
  }

  listActive(): EventView[] {
    const rows = this.database.all<EventRow>(
      `SELECT
         id,
         owner_id        AS ownerId,
         title,
         description,
         start_date      AS startDate,
         total_seats     AS totalSeats,
         remaining_seats AS remainingSeats,
         status,
         created_at      AS createdAt,
         updated_at      AS updatedAt
       FROM events
       WHERE status = 'active'`,
    );

    return rows.map((row) => this.toEventView(row));
  }

  getById(eventId: string): EventView {
    const event = this.database.get<EventRow>(
      `SELECT
         id,
         owner_id        AS ownerId,
         title,
         description,
         start_date      AS startDate,
         total_seats     AS totalSeats,
         remaining_seats AS remainingSeats,
         status,
         created_at      AS createdAt,
         updated_at      AS updatedAt
       FROM events
       WHERE id = ?`,
      [eventId],
    );

    if (!event) {
      throw new NotFoundException('Event not found.');
    }

    return this.toEventView(event);
  }

  private toEventView(event: EventRow): EventView {
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      startDate: event.startDate,
      totalSeats: event.totalSeats,
      remainingSeats: event.remainingSeats,
      status: event.status,
      soldOut: event.remainingSeats === 0,
    };
  }
}
