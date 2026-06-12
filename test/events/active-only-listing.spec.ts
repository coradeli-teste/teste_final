// Feature: event-ticket-reservation, Property 22: General listing returns exactly the active events
//
// Property 22: For any database state containing a mix of active and cancelled
// events, the general listing (EventsService.listActive) returns exactly the
// set of active events and excludes every cancelled event — and yields an empty
// collection when no event is active.
//
// Validates: Requirements 10.1, 10.5

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
const titleArbitrary: fc.Arbitrary<string> = asciiStringOfLength(1, 60);

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

/**
 * A small batch (0..8) of events. Each item carries the create payload plus a
 * boolean flagging whether the event should be cancelled after creation.
 */
const eventBatchArbitrary = fc.array(
  fc.record({
    title: titleArbitrary,
    startDate: futureStartDateArbitrary,
    totalSeats: totalSeatsArbitrary,
    cancel: fc.boolean(),
  }),
  { minLength: 0, maxLength: 8 },
);

describe('Property 22: General listing returns exactly the active events', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;
  let owner: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup; it promotes a fresh user to
    // ORGANIZER so that organizer can own the events created in each run.
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    adminActor = { id: seeded!.id, role: seeded!.role };

    // Register and promote one owning organizer reused across all runs.
    const { id } = ctx.users.register({
      login: `owner-${Date.now()}`,
      password: 'password123',
    });
    ctx.users.changeRole(adminActor, id, Role.ORGANIZER);
    owner = { id, role: Role.ORGANIZER };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('returns every active event created in a run and excludes the cancelled ones', async () => {
    await fc.assert(
      fc.asyncProperty(eventBatchArbitrary, async (batch) => {
        // The DB is shared across runs (events accumulate), so we assert
        // subset/exclusion relative to the ids created in THIS run rather than
        // against the global total.
        const activeIds = new Set<string>();
        const cancelledIds = new Set<string>();

        for (const item of batch) {
          const dto: CreateEventDto = {
            title: item.title,
            startDate: item.startDate,
            totalSeats: item.totalSeats,
          };
          const view = ctx.events.create(owner, dto);
          if (item.cancel) {
            ctx.events.cancel(owner, view.id);
            cancelledIds.add(view.id);
          } else {
            activeIds.add(view.id);
          }
        }

        const listed = ctx.events.listActive();
        const listedIds = new Set(listed.map((e) => e.id));

        // Req 10.1: every active event created in this run appears in the listing.
        for (const id of activeIds) {
          expect(listedIds.has(id)).toBe(true);
        }

        // Req 10.1: no cancelled event created in this run appears in the listing.
        for (const id of cancelledIds) {
          expect(listedIds.has(id)).toBe(false);
        }

        // Every returned event is active — the listing never leaks a
        // cancelled event regardless of which run created it.
        for (const view of listed) {
          expect(view.status).toBe('active');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns an empty collection when no event is active (Req 10.5)', async () => {
    // Use a truly fresh, isolated app: its events table starts empty (the seed
    // creates a user, not an event), so listActive() is exactly [].
    const fresh = await createTestApp();
    try {
      const admin = fresh.users.findByLogin('administrator');
      const freshAdmin: AuthUser = { id: admin!.id, role: admin!.role };
      const { id } = fresh.users.register({
        login: `owner-empty-${Date.now()}`,
        password: 'password123',
      });
      fresh.users.changeRole(freshAdmin, id, Role.ORGANIZER);
      const freshOwner: AuthUser = { id, role: Role.ORGANIZER };

      // No events at all -> empty listing.
      expect(fresh.events.listActive()).toEqual([]);

      // Create some events and cancel every one of them -> still empty listing.
      const startDate = new Date(Date.now() + 86_400_000).toISOString();
      for (let i = 0; i < 4; i++) {
        const view = fresh.events.create(freshOwner, {
          title: `to-cancel-${i}`,
          startDate,
          totalSeats: 10,
        });
        fresh.events.cancel(freshOwner, view.id);
      }
      expect(fresh.events.listActive()).toEqual([]);
    } finally {
      await fresh.cleanup();
    }
  });
});
