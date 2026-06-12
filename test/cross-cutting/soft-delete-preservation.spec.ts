// Feature: event-ticket-reservation, Property 34: Cancellation is soft-delete across all entities
//
// Property 34: For any cancellation of an event or a reservation, the system
// sets the corresponding status column to 'cancelled' and preserves all other
// column values of the existing row, never deleting the row.
//
// This is verified at the service level by varying (via fc.oneof) between two
// cancellation shapes:
//   - Event cancellation:       ctx.events.cancel(owner, eventId)
//   - Reservation cancellation: ctx.reservations.cancel(buyer, reservationId)
// In both shapes we snapshot the full row (SELECT *) and the table row count
// before the operation, then assert the row still exists, its status flipped to
// 'cancelled', every other column is preserved (updated_at may change), and the
// table row count did not decrease (no physical delete).
//
// Validates: Requirements 15.4

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
 * Produce a future ISO-8601 start date so neither event creation nor seat
 * reservation is rejected by the "must be in the future" / "already started"
 * guards. Offsets span 1..365 days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

/** Event seat capacity; kept modest so each iteration stays fast. */
const capacityArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8 });

/** The raw event row, exactly as stored in SQLite (snake_case columns). */
interface RawEventRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  start_date: string;
  total_seats: number;
  remaining_seats: number;
  status: string;
  created_at: string;
  updated_at: string;
}

/** The raw reservation row, exactly as stored in SQLite (snake_case columns). */
interface RawReservationRow {
  id: string;
  user_id: string;
  event_id: string;
  status: string;
  event_status_snapshot: string;
  created_at: string;
  updated_at: string;
}

/**
 * Discriminated arbitraries for the two cancellation shapes. Using fc.oneof so a
 * single property exercises both event-cancel and reservation-cancel paths.
 */
type CancelCase =
  | { kind: 'event'; startDate: string; totalSeats: number }
  | { kind: 'reservation'; startDate: string; totalSeats: number };

const cancelCaseArbitrary: fc.Arbitrary<CancelCase> = fc.oneof(
  fc.record({
    kind: fc.constant('event' as const),
    startDate: futureStartDateArbitrary,
    totalSeats: capacityArbitrary,
  }),
  fc.record({
    kind: fc.constant('reservation' as const),
    startDate: futureStartDateArbitrary,
    totalSeats: capacityArbitrary,
  }),
);

describe('Property 34: Cancellation is soft-delete across all entities', () => {
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

  it('flips status to cancelled, preserves all other columns, and never deletes the row', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        cancelCaseArbitrary,
        async (organizerLogin, password, testCase) => {
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

          // 2. Create an active, future event owned by that organizer.
          const createDto: CreateEventDto = {
            title: 'Soft-Delete Property Event',
            startDate: testCase.startDate,
            totalSeats: testCase.totalSeats,
          };
          const created = ctx.events.create(organizerActor, createDto);

          if (testCase.kind === 'event') {
            // --- Event cancellation path ---------------------------------
            const beforeCount = ctx.db.get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM events',
            )!.n;
            const before = ctx.db.get<RawEventRow>(
              'SELECT * FROM events WHERE id = ?',
              [created.id],
            );
            expect(before).toBeDefined();
            expect(before?.status).toBe('active');

            ctx.events.cancel(organizerActor, created.id);

            // Row still exists and its status is now 'cancelled'.
            const after = ctx.db.get<RawEventRow>(
              'SELECT * FROM events WHERE id = ?',
              [created.id],
            );
            expect(after).toBeDefined();
            expect(after?.status).toBe('cancelled');

            // Every non-status column is preserved (updated_at may change).
            expect(after?.id).toBe(before?.id);
            expect(after?.owner_id).toBe(before?.owner_id);
            expect(after?.title).toBe(before?.title);
            expect(after?.description).toBe(before?.description);
            expect(after?.start_date).toBe(before?.start_date);
            expect(after?.total_seats).toBe(before?.total_seats);
            expect(after?.remaining_seats).toBe(before?.remaining_seats);
            expect(after?.created_at).toBe(before?.created_at);

            // No physical delete: the events row count did not decrease.
            const afterCount = ctx.db.get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM events',
            )!.n;
            expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
          } else {
            // --- Reservation cancellation path ---------------------------
            // Register a buyer and reserve one seat on the future event.
            const { id: buyerId } = ctx.users.register({
              login: `${organizerLogin}-buyer`.slice(0, 254),
              password,
            });
            const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };
            const { reservationId } = ctx.reservations.reserve(
              buyerActor,
              created.id,
            );

            const beforeCount = ctx.db.get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM reservations',
            )!.n;
            const before = ctx.db.get<RawReservationRow>(
              'SELECT * FROM reservations WHERE id = ?',
              [reservationId],
            );
            expect(before).toBeDefined();
            expect(before?.status).toBe('active');

            ctx.reservations.cancel(buyerActor, reservationId);

            // Row still exists and its status is now 'cancelled'.
            const after = ctx.db.get<RawReservationRow>(
              'SELECT * FROM reservations WHERE id = ?',
              [reservationId],
            );
            expect(after).toBeDefined();
            expect(after?.status).toBe('cancelled');

            // Every non-status column is preserved (updated_at may change).
            expect(after?.id).toBe(before?.id);
            expect(after?.user_id).toBe(before?.user_id);
            expect(after?.event_id).toBe(before?.event_id);
            expect(after?.event_status_snapshot).toBe(
              before?.event_status_snapshot,
            );
            expect(after?.created_at).toBe(before?.created_at);

            // No physical delete: the reservations row count did not decrease.
            const afterCount = ctx.db.get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM reservations',
            )!.n;
            expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
