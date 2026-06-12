// Feature: event-ticket-reservation, Property 24: Reservation decrements seats by exactly one and never oversells
//
// Property 24: For any active, non-cancelled event with capacity C and any set
// of K distinct users each attempting one reservation, exactly min(K, C)
// reservations succeed (each creating one active reservation and decrementing
// remaining_seats by exactly one), remaining_seats never becomes negative and
// ends at max(C - K, 0), and every attempt beyond the C-th is rejected with
// HTTP 409.
//
// Validates: Requirements 11.1, 11.2, 11.4
//
// Approach (service-level): better-sqlite3 is synchronous and the transaction()
// helper uses BEGIN IMMEDIATE, so "concurrent" requests are effectively
// serialized. We therefore model the K attempts as a sequence: each distinct
// buyer makes a single reserve() call, and we count successes vs. HTTP 409
// rejections, then assert the seat accounting holds exactly.

import fc from 'fast-check';
import { ConflictException } from '@nestjs/common';

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
 * Event capacity C. Kept small (1..8) so each iteration stays fast while still
 * exercising the boundary where capacity is exhausted.
 */
const capacityArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8 });

/**
 * Number of distinct buyers K, each attempting exactly one reservation. Spans
 * 0..12 so we cover under-capacity (K < C), exact-capacity (K === C), and
 * over-capacity (K > C) cases, including the zero-attempt case.
 */
const buyerCountArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 12,
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

describe('Property 24: Reservation decrements seats by exactly one and never oversells', () => {
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

  it('lets exactly min(K, C) reservations succeed, rejects the rest with 409, and never oversells', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        capacityArbitrary,
        buyerCountArbitrary,
        async (
          organizerLogin,
          organizerPassword,
          startDate,
          capacity,
          buyerCount,
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

          // 2. Create an active event with totalSeats = C and a future start.
          const createDto: CreateEventDto = {
            title: 'Atomic Decrement Event',
            startDate,
            totalSeats: capacity,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 3. Register K distinct buyers, each attempting one reservation.
          //    Count successes and HTTP 409 rejections.
          let successes = 0;
          let conflictRejections = 0;

          for (let i = 0; i < buyerCount; i++) {
            const { id: buyerId } = ctx.users.register({
              login: `${organizerLogin}-buyer-${i}`.slice(0, 254),
              password: organizerPassword,
            });
            const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };

            try {
              const result = ctx.reservations.reserve(buyerActor, created.id);
              successes += 1;
              // Each success returns a defined reservation id and a
              // non-negative remaining-seat count.
              expect(typeof result.reservationId).toBe('string');
              expect(result.remainingSeats).toBeGreaterThanOrEqual(0);
            } catch (error) {
              // Overflow attempts (beyond the C-th) must be 409 conflicts.
              expect(error).toBeInstanceOf(ConflictException);
              expect((error as ConflictException).getStatus()).toBe(409);
              conflictRejections += 1;
            }
          }

          const expectedSuccesses = Math.min(buyerCount, capacity);
          const expectedRejections = Math.max(buyerCount - capacity, 0);

          // 4a. Exactly min(K, C) attempts succeed.
          expect(successes).toBe(expectedSuccesses);
          // 4b. Every attempt beyond the C-th is rejected with 409.
          expect(conflictRejections).toBe(expectedRejections);

          // 4c. Final remaining_seats equals max(C - K, 0), never negative, and
          //     equals C minus the number of successful decrements (each
          //     success decrements by exactly one).
          const row = ctx.db.get<{ remaining_seats: number }>(
            'SELECT remaining_seats FROM events WHERE id = ?',
            [created.id],
          );
          expect(row).toBeDefined();
          const remaining = row!.remaining_seats;
          expect(remaining).toBe(Math.max(capacity - buyerCount, 0));
          expect(remaining).toBeGreaterThanOrEqual(0);
          expect(remaining).toBe(capacity - successes);

          // 4d. The number of active reservations equals min(K, C): each
          //     success created exactly one active reservation.
          const activeCount = ctx.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM reservations
              WHERE event_id = ? AND status = 'active'`,
            [created.id],
          );
          expect(activeCount?.count).toBe(expectedSuccesses);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
