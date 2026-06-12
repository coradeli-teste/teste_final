// Feature: event-ticket-reservation, Property 26: Reservations are blocked on started or cancelled events
//
// Property 26: For any event whose start date/time has passed, a reservation
// request is rejected with HTTP 400 (BadRequestException); and for any event
// whose status is cancelled, a reservation request is rejected with HTTP 409
// (ConflictException). In both cases no reservation is created and the event's
// remaining_seats is unchanged.
//
// Validates: Requirements 11.5, 11.6

import { BadRequestException, ConflictException } from '@nestjs/common';
import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import { CreateEventDto } from '../../src/dto';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/**
 * Seat capacity for the event under test. Kept small (1..20) so each iteration
 * stays fast while still varying the snapshot we assert remains unchanged.
 */
const seatsArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 20 });

/**
 * How many days into the past to push a started event's start_date. Varying
 * the offset (1..3650 days) exercises the "any event whose start date has
 * passed" clause without relying on a single boundary value.
 */
const pastOffsetDaysArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 3650,
});

/**
 * A future ISO-8601 start date so the event can be created through the normal
 * path (EventsService.create rejects past start dates). Offsets span 1..365
 * days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

describe('Property 26: Reservations are blocked on started or cancelled events', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup; resolve it to promote organizers.
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    adminActor = { id: seeded!.id, role: seeded!.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** Register a fresh BUYER and return its AuthUser. */
  const makeBuyer = (login: string, password: string): AuthUser => {
    const { id } = ctx.users.register({ login, password });
    return { id, role: Role.BUYER };
  };

  /** Register a user and promote it to ORGANIZER via the seeded admin. */
  const makeOrganizer = (login: string, password: string): AuthUser => {
    const { id } = ctx.users.register({ login, password });
    ctx.users.changeRole(adminActor, id, Role.ORGANIZER);
    return { id, role: Role.ORGANIZER };
  };

  /** Read the persisted remaining_seats for an event. */
  const remainingSeatsOf = (eventId: string): number =>
    ctx.db.get<{ remaining_seats: number }>(
      'SELECT remaining_seats FROM events WHERE id = ?',
      [eventId],
    )!.remaining_seats;

  /** Count active reservations for an event (used to assert none was created). */
  const reservationCountOf = (eventId: string): number =>
    ctx.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM reservations WHERE event_id = ?',
      [eventId],
    )!.count;

  it('rejects a reservation for a started event with HTTP 400 and leaves seats unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        seatsArbitrary,
        pastOffsetDaysArbitrary,
        async (login, password, startDate, seats, pastOffsetDays) => {
          const organizer = makeOrganizer(login, password);

          // Create the event through the normal path with a future start date.
          const createDto: CreateEventDto = {
            title: 'Started Event',
            startDate,
            totalSeats: seats,
          };
          const created = ctx.events.create(organizer, createDto);

          // The service rejects past start dates on create, so seed a started
          // event by pushing start_date into the past via direct SQL. Status
          // stays 'active' so the started-event guard (400) is exercised rather
          // than the cancelled-event guard (409).
          const pastDate = new Date(
            Date.now() - pastOffsetDays * 24 * 60 * 60 * 1000,
          ).toISOString();
          ctx.db.run('UPDATE events SET start_date = ? WHERE id = ?', [
            pastDate,
            created.id,
          ]);

          const buyer = makeBuyer(`${login}-buyer`.slice(0, 254), password);

          const seatsBefore = remainingSeatsOf(created.id);
          const countBefore = reservationCountOf(created.id);

          // Reservation on a started event must be rejected with HTTP 400.
          expect(() => ctx.reservations.reserve(buyer, created.id)).toThrow(
            BadRequestException,
          );

          // No reservation created and remaining_seats unchanged.
          expect(reservationCountOf(created.id)).toBe(countBefore);
          expect(remainingSeatsOf(created.id)).toBe(seatsBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects a reservation for a cancelled event with HTTP 409 and leaves seats unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        seatsArbitrary,
        async (login, password, startDate, seats) => {
          const organizer = makeOrganizer(login, password);

          // Create a future event, then cancel it through the owning organizer.
          const createDto: CreateEventDto = {
            title: 'Cancelled Event',
            startDate,
            totalSeats: seats,
          };
          const created = ctx.events.create(organizer, createDto);
          ctx.events.cancel(organizer, created.id);

          const buyer = makeBuyer(`${login}-buyer`.slice(0, 254), password);

          const seatsBefore = remainingSeatsOf(created.id);
          const countBefore = reservationCountOf(created.id);

          // Reservation on a cancelled event must be rejected with HTTP 409.
          expect(() => ctx.reservations.reserve(buyer, created.id)).toThrow(
            ConflictException,
          );

          // No reservation created and remaining_seats unchanged.
          expect(reservationCountOf(created.id)).toBe(countBefore);
          expect(remainingSeatsOf(created.id)).toBe(seatsBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
