// Feature: event-ticket-reservation, Property 21: Event cancellation propagates into all reservation histories
//
// Property 21: For any event holding any number of reservations, cancelling the
// event sets the event_status_snapshot to 'cancelled' for every reservation of
// that event, independently of each reservation's own participation status.
//
// Validates: Requirements 9.3

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
 * Number of distinct buyers (N) that reserve a seat for the event before it is
 * cancelled. Kept small (0..8) so each iteration — which registers N buyers and
 * reserves a seat for each — stays fast while still exercising the "any number
 * of reservations" clause, including the zero-reservation case.
 */
const reservationCountArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 8,
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

describe('Property 21: Event cancellation propagates into all reservation histories', () => {
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

  it("sets event_status_snapshot='cancelled' for every reservation, regardless of participation status", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        reservationCountArbitrary,
        // A boolean per buyer deciding whether that buyer's reservation is
        // cancelled before the event cancellation, so a mix of active and
        // cancelled participation statuses coexists for the same event.
        fc.array(fc.boolean(), { minLength: 0, maxLength: 8 }),
        async (
          organizerLogin,
          organizerPassword,
          startDate,
          reservationCount,
          cancelFlags,
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

          // 2. Create an event with seats >= N so all reservations succeed.
          const initialSeats = Math.max(reservationCount, 1);
          const createDto: CreateEventDto = {
            title: 'Cancellation Propagation Event',
            startDate,
            totalSeats: initialSeats,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 3. Make N reservations from N distinct fresh buyers, recording each
          //    reservation id alongside whether we intend to cancel it. To
          //    exercise "independently of participation status", cancel some of
          //    them so a mix of 'active' and 'cancelled' participations exists.
          const reservations: Array<{
            reservationId: string;
            cancelled: boolean;
          }> = [];
          for (let i = 0; i < reservationCount; i++) {
            const { id: buyerId } = ctx.users.register({
              login: `${organizerLogin}-buyer-${i}`.slice(0, 254),
              password: organizerPassword,
            });
            const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };
            const { reservationId } = ctx.reservations.reserve(
              buyerActor,
              created.id,
            );

            const shouldCancel = cancelFlags[i] ?? false;
            if (shouldCancel) {
              ctx.reservations.cancel(buyerActor, reservationId);
            }
            reservations.push({ reservationId, cancelled: shouldCancel });
          }

          // Sanity: before the event cancellation, every snapshot is still
          // 'active' regardless of participation status.
          const beforeRows = ctx.db.all<{
            id: string;
            status: string;
            event_status_snapshot: string;
          }>(
            `SELECT id, status, event_status_snapshot
               FROM reservations WHERE event_id = ?`,
            [created.id],
          );
          expect(beforeRows.length).toBe(reservationCount);
          for (const row of beforeRows) {
            expect(row.event_status_snapshot).toBe('active');
          }

          // 4. Cancel the event via the owning organizer.
          ctx.events.cancel(organizerActor, created.id);

          // 5a. Every reservation of the event now has the cancelled snapshot,
          //     independent of its own participation status.
          const afterRows = ctx.db.all<{
            id: string;
            status: string;
            event_status_snapshot: string;
          }>(
            `SELECT id, status, event_status_snapshot
               FROM reservations WHERE event_id = ?`,
            [created.id],
          );
          expect(afterRows.length).toBe(reservationCount);
          for (const row of afterRows) {
            expect(row.event_status_snapshot).toBe('cancelled');
          }

          // 5b. The propagation does NOT alter participation status: the ones we
          //     cancelled stay 'cancelled' and the rest stay 'active'.
          const byId = new Map(afterRows.map((row) => [row.id, row]));
          for (const { reservationId, cancelled } of reservations) {
            const row = byId.get(reservationId);
            expect(row).toBeDefined();
            expect(row?.status).toBe(cancelled ? 'cancelled' : 'active');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
