// Feature: event-ticket-reservation, Property 25: A user cannot hold two active reservations for one event
//
// Property 25: For any user who already holds an active reservation for an
// event, a second reservation request for that same event is rejected with
// HTTP 409 (ConflictException) and the event's remaining_seats is unchanged by
// the rejected request. The user still holds exactly ONE active reservation for
// the event.
//
// Validates: Requirements 11.3

import { ConflictException } from '@nestjs/common';
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
 * Total seats for the event. Generated >= 2 so that, even after the first
 * (successful) reservation decrements one seat, at least one seat remains
 * available — this guarantees the second request is rejected by the
 * duplicate-active-reservation guard (Req 11.3) and NOT by a sold-out guard.
 */
const totalSeatsArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 2,
  max: 1000,
});

/**
 * Produce a future ISO-8601 start date so reservations are never blocked by the
 * "event already started" guard. Offsets span 1..365 days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

describe('Property 25: A user cannot hold two active reservations for one event', () => {
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

  it('rejects a second reservation with 409 and leaves remaining_seats unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        totalSeatsArbitrary,
        async (
          organizerLogin,
          organizerPassword,
          buyerLogin,
          buyerPassword,
          startDate,
          totalSeats,
        ) => {
          // 1. Create an owning organizer: register, then promote via admin.
          const { id: organizerId } = ctx.users.register({
            login: organizerLogin,
            password: organizerPassword,
          });
          ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
          const organizerActor: AuthUser = {
            id: organizerId,
            role: Role.ORGANIZER,
          };

          // 2. Create a future event with at least two seats.
          const createDto: CreateEventDto = {
            title: 'Duplicate Reservation Event',
            startDate,
            totalSeats,
          };
          const event = ctx.events.create(organizerActor, createDto);

          // 3. Register a buyer and make the first (successful) reservation.
          const { id: buyerId } = ctx.users.register({
            login: buyerLogin,
            password: buyerPassword,
          });
          const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };

          const first = ctx.reservations.reserve(buyerActor, event.id);
          expect(first.remainingSeats).toBe(totalSeats - 1);

          // Capture remaining_seats from the database after the first success.
          const seatsAfterFirst = ctx.db.get<{ remaining_seats: number }>(
            'SELECT remaining_seats FROM events WHERE id = ?',
            [event.id],
          );
          expect(seatsAfterFirst?.remaining_seats).toBe(totalSeats - 1);

          // 4. The SAME buyer attempts a second reservation for the SAME event.
          //    It must be rejected with a 409 ConflictException.
          expect(() => ctx.reservations.reserve(buyerActor, event.id)).toThrow(
            ConflictException,
          );

          // 5a. remaining_seats is unchanged by the rejected request.
          const seatsAfterSecond = ctx.db.get<{ remaining_seats: number }>(
            'SELECT remaining_seats FROM events WHERE id = ?',
            [event.id],
          );
          expect(seatsAfterSecond?.remaining_seats).toBe(totalSeats - 1);

          // 5b. The buyer still holds exactly ONE active reservation.
          const activeCount = ctx.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM reservations
              WHERE user_id = ? AND event_id = ? AND status = 'active'`,
            [buyerId, event.id],
          );
          expect(activeCount?.count).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
