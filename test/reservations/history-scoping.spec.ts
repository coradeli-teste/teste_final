// Feature: event-ticket-reservation, Property 29: History returns exactly the user's own reservations with correct fields
//
// Property 29: A user's reservation history returns EXACTLY that user's own
// reservations — both active and cancelled participations — and never any
// reservation belonging to a different user. Each returned entry carries a
// reservationId, the eventId of the reserved event, a participationStatus that
// matches the reservation's own status (active/cancelled), and an eventStatus
// field. A user holding no reservations gets an empty history.
//
// Validates: Requirements 13.1, 13.2, 13.4, 13.5

import fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';

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
 * Per-event scenario for a single property run.
 *
 *  - `capacity`      seat capacity (>= 3) so the at-most-3 reservers per event
 *                    (the subject plus up to two others) can never sell it out.
 *  - `subjectAction` what the subject user (U) does on this event: nothing,
 *                    reserve and keep active, or reserve then cancel.
 *  - `otherCount`    how many OTHER users also reserve this event; their
 *                    reservations must never appear in U's history.
 */
interface EventSpec {
  capacity: number;
  subjectAction: 'none' | 'active' | 'cancelled';
  otherCount: number;
}

const eventSpecArbitrary: fc.Arbitrary<EventSpec> = fc.record({
  capacity: fc.integer({ min: 3, max: 8 }),
  subjectAction: fc.constantFrom<'none' | 'active' | 'cancelled'>(
    'none',
    'active',
    'cancelled',
  ),
  otherCount: fc.integer({ min: 0, max: 2 }),
});

/** 1..3 events per run keeps each iteration small while still varying scope. */
const eventSpecsArbitrary: fc.Arbitrary<EventSpec[]> = fc.array(
  eventSpecArbitrary,
  { minLength: 1, maxLength: 3 },
);

/**
 * A future ISO-8601 start date so reservations are never blocked by the
 * "event already started" guard.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

describe('Property 29: History returns exactly the user reservations with correct fields', () => {
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

  it('returns the union of the subject active and cancelled reservations, excludes others, and carries the required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        eventSpecsArbitrary,
        async (organizerLogin, password, startDate, specs) => {
          // 1. Create the owning organizer (register, then promote via admin).
          const { id: organizerId } = ctx.users.register({
            login: organizerLogin,
            password,
          });
          ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
          const organizerActor: AuthUser = {
            id: organizerId,
            role: Role.ORGANIZER,
          };

          // 2. Create the subject user U whose history we will inspect.
          const { id: subjectId } = ctx.users.register({
            login: `subject-${uuidv4()}`,
            password,
          });
          const subjectActor: AuthUser = { id: subjectId, role: Role.BUYER };

          // Expected: reservationId -> the participation status it must report.
          const expected = new Map<
            string,
            { eventId: string; participationStatus: 'active' | 'cancelled' }
          >();

          for (const spec of specs) {
            // 3. Create an active, future event with enough seats for everyone.
            const createDto: CreateEventDto = {
              title: `History Event ${uuidv4()}`,
              startDate,
              totalSeats: spec.capacity,
            };
            const event = ctx.events.create(organizerActor, createDto);

            // 4. The subject reserves (and maybe cancels) this event.
            if (spec.subjectAction !== 'none') {
              const { reservationId } = ctx.reservations.reserve(
                subjectActor,
                event.id,
              );
              if (spec.subjectAction === 'cancelled') {
                ctx.reservations.cancel(subjectActor, reservationId);
              }
              expected.set(reservationId, {
                eventId: event.id,
                participationStatus: spec.subjectAction,
              });
            }

            // 5. OTHER users reserve the same event. These reservations MUST
            //    never surface in the subject's history (scoping, Req 13.1).
            for (let i = 0; i < spec.otherCount; i++) {
              const { id: otherId } = ctx.users.register({
                login: `other-${uuidv4()}`,
                password,
              });
              const otherActor: AuthUser = { id: otherId, role: Role.BUYER };
              ctx.reservations.reserve(otherActor, event.id);
            }
          }

          // 6. Read the subject's history.
          const history = ctx.reservations.history(subjectActor);

          // 6a. The set of returned reservation ids equals EXACTLY the subject's
          //     own reservations (active + cancelled), none belonging to others.
          const returnedIds = history.map((entry) => entry.reservationId);
          expect(new Set(returnedIds)).toEqual(new Set(expected.keys()));
          // No duplicates and no extras.
          expect(returnedIds).toHaveLength(expected.size);

          // 6b. Every entry carries the required fields with the correct values.
          for (const entry of history) {
            const want = expected.get(entry.reservationId);
            expect(want).toBeDefined();
            // eventId matches the reserved event (Req 13.4).
            expect(entry.eventId).toBe(want!.eventId);
            // participationStatus matches the reservation's own status and is
            // one of the two allowed values (Req 13.2).
            expect(entry.participationStatus).toBe(want!.participationStatus);
            expect(['active', 'cancelled']).toContain(
              entry.participationStatus,
            );
            // The eventStatus field is present; none of these events were
            // cancelled, so it reports the active snapshot.
            expect(entry.eventStatus).toBe('active');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns an empty history for a user who holds no reservations (Req 13.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        async (login, password) => {
          const { id } = ctx.users.register({ login, password });
          const actor: AuthUser = { id, role: Role.BUYER };

          const history = ctx.reservations.history(actor);
          expect(history).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
