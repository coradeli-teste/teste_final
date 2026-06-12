// Feature: event-ticket-reservation, Property 23: Sold-out flag equals seat exhaustion for active events
//
// Property 23: For any active event, both in the listing and in a single-event
// read by valid existing id, the soldOut flag is true if and only if its
// remaining_seats equals zero.
//
// Validates: Requirements 10.2, 10.3, 10.6

import fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';

import { AuthUser, Role } from '../../src/common/types';
import { CreateEventDto } from '../../src/dto';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/**
 * Small total seat capacity C in [1, 6]. Keeping C small bounds the number of
 * buyer registrations + reservations per iteration so the suite stays fast.
 */
const totalSeatsArbitrary: fc.Arbitrary<number> = fc.integer({ min: 1, max: 6 });

/**
 * A strictly-future ISO-8601 start date so reservations are never blocked by
 * the "event already started" guard (Requirement 11.5). Offsets span 1..365
 * days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

describe('Property 23: Sold-out flag equals seat exhaustion for active events', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;
  let organizerActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup; resolve it to promote organizers.
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    adminActor = { id: seeded!.id, role: seeded!.role };

    // Create one owning organizer reused across all generated events.
    const { id: organizerId } = ctx.users.register({
      login: `organizer-${Date.now()}`,
      password: 'organizer-password',
    });
    ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
    organizerActor = { id: organizerId, role: Role.ORGANIZER };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('reports soldOut iff remaining_seats === 0 in both getById and listActive', async () => {
    await fc.assert(
      fc.asyncProperty(
        futureStartDateArbitrary,
        totalSeatsArbitrary,
        // Reserve fraction in [0, 1] mapped to K in [0, C] so the full range
        // (including the exhausted K === C case) is exercised.
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (startDate, totalSeats, reserveFraction) => {
          const capacity = totalSeats;
          const reserved = Math.round(reserveFraction * capacity);

          // 1. Create an active event with capacity C, owned by the organizer.
          const createDto: CreateEventDto = {
            title: 'Sold-Out Property Event',
            startDate,
            totalSeats: capacity,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 2. Reserve K seats, each from a distinct fresh buyer (unique login
          //    via uuid). remaining_seats becomes C - K; when K === C the event
          //    is exhausted (remaining 0).
          for (let i = 0; i < reserved; i++) {
            const { id: buyerId } = ctx.users.register({
              login: `buyer-${uuidv4()}`,
              password: 'buyer-password',
            });
            const buyerActor: AuthUser = { id: buyerId, role: Role.BUYER };
            ctx.reservations.reserve(buyerActor, created.id);
          }

          const expectedRemaining = capacity - reserved;
          const expectedSoldOut = expectedRemaining === 0;

          // 3a. Single-event read by valid existing id (Req 10.6).
          const single = ctx.events.getById(created.id);
          expect(single.remainingSeats).toBe(expectedRemaining);
          expect(single.soldOut).toBe(single.remainingSeats === 0);
          expect(single.soldOut).toBe(expectedSoldOut);

          // 3b. The same event located within the active listing (Req 10.2, 10.3).
          const listed = ctx.events
            .listActive()
            .find((event) => event.id === created.id);
          expect(listed).toBeDefined();
          expect(listed!.remainingSeats).toBe(expectedRemaining);
          expect(listed!.soldOut).toBe(listed!.remainingSeats === 0);
          expect(listed!.soldOut).toBe(expectedSoldOut);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
