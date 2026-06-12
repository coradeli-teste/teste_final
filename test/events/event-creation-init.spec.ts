// Feature: event-ticket-reservation, Property 15: Event creation initializes ownership, seats, and status
//
// Property 15: For any organizer or administrator actor and any valid event
// payload (total seats in [1, 1,000,000], start date in the future), the
// created event is owned by the actor, has remaining_seats equal to
// total_seats, and has status active.
//
// Validates: Requirements 7.1, 7.2, 7.3

import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import { CreateEventDto } from '../../src/dto';
import {
  asciiStringOfLength,
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Non-empty title within a reasonable bound (DTO requires a non-empty string). */
const titleArbitrary: fc.Arbitrary<string> = asciiStringOfLength(1, 120);

/** Optional description: either absent or a printable-ASCII string. */
const descriptionArbitrary: fc.Arbitrary<string | undefined> = fc.option(
  asciiStringOfLength(0, 200),
  { nil: undefined },
);

/**
 * A strictly-future ISO-8601 instant. Adds between 1 ms and ~115 days to the
 * current time so the start date is always > now at the moment of creation.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 10_000_000_000 })
  .map((ms) => new Date(Date.now() + ms).toISOString());

/** Valid total seat capacity: whole integer in [1, 1,000,000] (Req 7.x bounds). */
const totalSeatsArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

/** The two actor roles permitted to create events (Requirement 7.1). */
const actorRoleArbitrary: fc.Arbitrary<Role.ORGANIZER | Role.ADMINISTRATOR> =
  fc.constantFrom(Role.ORGANIZER, Role.ADMINISTRATOR);

describe('Property 15: Event creation initializes ownership, seats, and status', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup (login/password "administrator",
    // role ADMINISTRATOR). It is both an event-creating actor (ADMINISTRATOR
    // case) and the authority that promotes fresh users to ORGANIZER.
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    adminActor = { id: seeded!.id, role: seeded!.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('owns the event by the actor with remaining_seats = total_seats and status active', async () => {
    await fc.assert(
      fc.asyncProperty(
        actorRoleArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        titleArbitrary,
        descriptionArbitrary,
        futureStartDateArbitrary,
        totalSeatsArbitrary,
        async (role, login, password, title, description, startDate, totalSeats) => {
          // Build an actor whose owner_id exists as a real user (FK target).
          let actor: AuthUser;
          if (role === Role.ADMINISTRATOR) {
            // Reuse the seeded administrator as the ADMINISTRATOR actor.
            actor = adminActor;
          } else {
            // Register a fresh BUYER and have the seeded admin promote it to
            // ORGANIZER so it can own an event.
            const { id } = ctx.users.register({ login, password });
            ctx.users.changeRole(adminActor, id, Role.ORGANIZER);
            actor = { id, role: Role.ORGANIZER };
          }

          const dto: CreateEventDto = {
            title,
            startDate,
            totalSeats,
            ...(description !== undefined ? { description } : {}),
          };

          const view = ctx.events.create(actor, dto);

          // The returned view reflects the initialization (Req 7.2, 7.3).
          expect(view.totalSeats).toBe(totalSeats);
          expect(view.remainingSeats).toBe(totalSeats);
          expect(view.status).toBe('active');

          // The persisted row confirms ownership, seats, and status.
          const row = ctx.db.get<{
            owner_id: string;
            total_seats: number;
            remaining_seats: number;
            status: string;
          }>(
            `SELECT owner_id, total_seats, remaining_seats, status
             FROM events WHERE id = ?`,
            [view.id],
          );
          expect(row).toBeDefined();
          // Req 7.1: the event is owned by the acting actor.
          expect(row?.owner_id).toBe(actor.id);
          // Req 7.2: remaining_seats equals total_seats equals the requested capacity.
          expect(row?.remaining_seats).toBe(totalSeats);
          expect(row?.total_seats).toBe(totalSeats);
          // Req 7.3: the event status is active.
          expect(row?.status).toBe('active');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
