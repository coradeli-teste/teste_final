// Feature: event-ticket-reservation, Property 17: Owner event update recomputes remaining seats consistently
//
// Property 17: For any event with R reserved (active) seats updated by its
// owning organizer to a new total capacity T where T >= R, the update persists
// and remaining_seats equals T - R.
//
// Validates: Requirements 8.1

import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import { CreateEventDto, UpdateEventDto } from '../../src/dto';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Upper bound for seat capacity, matching the DTO/schema constraint. */
const MAX_TOTAL_SEATS = 1_000_000;

/**
 * Number of active reservations (R) to place before the update. Kept small so
 * each iteration — which registers R distinct buyers and reserves a seat for
 * each — stays fast.
 */
const reservedCountArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 10,
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

describe('Property 17: Owner event update recomputes remaining seats consistently', () => {
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

  it('persists T as total_seats and recomputes remaining_seats to T - R', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        reservedCountArbitrary,
        // Non-negative delta used to derive a new total T = max(R + delta, 1),
        // guaranteeing T >= R while staying within the capacity upper bound.
        fc.integer({ min: 0, max: 1000 }),
        async (
          organizerLogin,
          organizerPassword,
          startDate,
          reserved,
          totalDelta,
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

          // 2. Create an event with capacity large enough to host R reservations.
          //    initialSeats must be >= max(R, 1) (capacity lower bound is 1).
          const initialSeats = Math.max(reserved, 1);
          const createDto: CreateEventDto = {
            title: 'Recompute Property Event',
            startDate,
            totalSeats: initialSeats,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 3. Make R active reservations, each from a distinct fresh buyer.
          for (let i = 0; i < reserved; i++) {
            const { id: buyerId } = ctx.users.register({
              login: `${organizerLogin}-buyer-${i}`.slice(0, 254),
              password: organizerPassword,
            });
            const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };
            ctx.reservations.reserve(buyerActor, created.id);
          }

          // Sanity: the event now has exactly R active reservations.
          const activeReservations = ctx.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM reservations
              WHERE event_id = ? AND status = 'active'`,
            [created.id],
          );
          expect(activeReservations?.count).toBe(reserved);

          // 4. Choose a new total capacity T with T >= R, then update.
          //    T = max(R + delta, 1): always >= R and within [1, MAX_TOTAL_SEATS].
          const targetTotal = Math.min(
            Math.max(reserved + totalDelta, 1),
            MAX_TOTAL_SEATS,
          );
          const updateDto: UpdateEventDto = { totalSeats: targetTotal };
          const view = ctx.events.update(
            organizerActor,
            created.id,
            updateDto,
          );

          // 5a. The update persisted total_seats = T and remaining = T - R.
          const row = ctx.db.get<{
            total_seats: number;
            remaining_seats: number;
          }>('SELECT total_seats, remaining_seats FROM events WHERE id = ?', [
            created.id,
          ]);
          expect(row?.total_seats).toBe(targetTotal);
          expect(row?.remaining_seats).toBe(targetTotal - reserved);

          // 5b. The returned EventView reflects the recomputed remaining seats.
          expect(view.totalSeats).toBe(targetTotal);
          expect(view.remainingSeats).toBe(targetTotal - reserved);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
