// Feature: event-ticket-reservation, Property 27: Cancelling a reservation returns one seat without exceeding capacity
//
// Property 27: For any active reservation owned by the requesting user,
// cancellation sets the reservation status to 'cancelled' (preserving all
// other columns) and sets the event's remaining_seats to
// min(previous remaining + 1, total_seats) within a single atomic transaction.
//
// Validates: Requirements 12.1

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
 * Total seat capacity (C) of the event under test. Kept small (1..8) so each
 * iteration stays fast while still varying capacity, including the single-seat
 * edge where reserve + cancel must round-trip remaining_seats back to exactly C.
 */
const capacityArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8 });

/**
 * Produce a future ISO-8601 start date so the reservation is never blocked by
 * the "event already started" guard. Offsets span 1..365 days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

/** Shape of the full reservation row used for column-preservation assertions. */
interface ReservationRow {
  id: string;
  user_id: string;
  event_id: string;
  status: string;
  event_status_snapshot: string;
  created_at: string;
  updated_at: string;
}

describe('Property 27: Cancelling a reservation returns one seat without exceeding capacity', () => {
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

  it("flips status to 'cancelled', preserves all other columns, and returns the seat capped at total_seats", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        capacityArbitrary,
        async (organizerLogin, password, startDate, capacity) => {
          // 1. Create an owning organizer: register, then promote via admin.
          const { id: organizerId } = ctx.users.register({
            login: organizerLogin,
            password,
          });
          ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
          const organizerActor: AuthUser = {
            id: organizerId,
            role: Role.ORGANIZER,
          };

          // 2. Create an active, future event with capacity C.
          const createDto: CreateEventDto = {
            title: 'Seat Return Event',
            startDate,
            totalSeats: capacity,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 3. Register a buyer and reserve one seat.
          const { id: buyerId } = ctx.users.register({
            login: `${organizerLogin}-buyer`.slice(0, 254),
            password,
          });
          const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };
          const { reservationId } = ctx.reservations.reserve(
            buyerActor,
            created.id,
          );

          // 4. Capture the full reservation row and the event seats BEFORE the
          //    cancellation so we can assert column preservation and the seat
          //    math afterwards.
          const beforeReservation = ctx.db.get<ReservationRow>(
            'SELECT * FROM reservations WHERE id = ?',
            [reservationId],
          );
          expect(beforeReservation).toBeDefined();
          expect(beforeReservation?.status).toBe('active');

          const beforeEvent = ctx.db.get<{
            remaining_seats: number;
            total_seats: number;
          }>('SELECT remaining_seats, total_seats FROM events WHERE id = ?', [
            created.id,
          ]);
          expect(beforeEvent).toBeDefined();
          const prevRemaining = beforeEvent!.remaining_seats;
          const totalSeats = beforeEvent!.total_seats;
          // After a single reservation against fresh capacity C, remaining = C-1.
          expect(prevRemaining).toBe(capacity - 1);
          expect(totalSeats).toBe(capacity);

          // 5. Cancel the reservation as its owner.
          ctx.reservations.cancel(buyerActor, reservationId);

          // 6a. The reservation status is now 'cancelled' and every other column
          //     is preserved byte-for-byte (updated_at is allowed to change).
          const afterReservation = ctx.db.get<ReservationRow>(
            'SELECT * FROM reservations WHERE id = ?',
            [reservationId],
          );
          expect(afterReservation).toBeDefined();
          expect(afterReservation?.status).toBe('cancelled');
          expect(afterReservation?.id).toBe(beforeReservation?.id);
          expect(afterReservation?.user_id).toBe(beforeReservation?.user_id);
          expect(afterReservation?.event_id).toBe(beforeReservation?.event_id);
          expect(afterReservation?.event_status_snapshot).toBe(
            beforeReservation?.event_status_snapshot,
          );
          expect(afterReservation?.created_at).toBe(
            beforeReservation?.created_at,
          );

          // 6b. The event's remaining_seats equals min(prevRemaining + 1,
          //     total_seats) and never exceeds capacity.
          const afterEvent = ctx.db.get<{ remaining_seats: number }>(
            'SELECT remaining_seats FROM events WHERE id = ?',
            [created.id],
          );
          expect(afterEvent).toBeDefined();
          const expectedRemaining = Math.min(prevRemaining + 1, totalSeats);
          expect(afterEvent?.remaining_seats).toBe(expectedRemaining);
          expect(afterEvent?.remaining_seats).toBe(capacity);
          expect(afterEvent!.remaining_seats).toBeLessThanOrEqual(totalSeats);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
