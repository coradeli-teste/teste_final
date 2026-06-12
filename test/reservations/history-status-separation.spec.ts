// Feature: event-ticket-reservation, Property 30: History reports event status separately from participation status
//
// Property 30: For any reservation belonging to a cancelled event, its history
// entry reports the event status as cancelled distinctly from, and
// independently of, the reservation's own participation status.
//
// Validates: Requirements 13.3

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
 * Produce a future ISO-8601 start date so reservations are never blocked by the
 * "event already started" guard. Offsets span 1..365 days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

/**
 * One reservation scenario for the subject user U on its own dedicated event:
 *   - `cancelParticipation`: U cancels their OWN reservation (participation
 *     status becomes 'cancelled') while the event itself stays active.
 *   - `cancelEvent`: the EVENT is cancelled (event_status_snapshot becomes
 *     'cancelled') while U's participation is untouched.
 * The two flags vary independently, so across a run all four combinations of
 * (participationStatus) x (eventStatus) occur.
 */
interface Combo {
  cancelParticipation: boolean;
  cancelEvent: boolean;
}

const comboArbitrary: fc.Arbitrary<Combo> = fc.record({
  cancelParticipation: fc.boolean(),
  cancelEvent: fc.boolean(),
});

/**
 * The four canonical combinations are always included so every iteration
 * exercises — and can assert the existence of — both cross combinations that
 * prove the two statuses are reported separately:
 *   (participation active   + event cancelled)  -> event cancelled, U enrolled
 *   (participation cancelled + event active)     -> U opted out, event live
 */
const BASE_COMBOS: Combo[] = [
  { cancelParticipation: false, cancelEvent: false },
  { cancelParticipation: true, cancelEvent: false },
  { cancelParticipation: false, cancelEvent: true },
  { cancelParticipation: true, cancelEvent: true },
];

describe('Property 30: History reports event status separately from participation status', () => {
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

  it('reports eventStatus (snapshot) and participationStatus independently for each entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        // A few extra random combos on top of the four canonical ones, so the
        // mix of (participation x event) statuses varies across iterations.
        fc.array(comboArbitrary, { minLength: 0, maxLength: 4 }),
        async (
          organizerLogin,
          subjectLogin,
          password,
          startDate,
          extraCombos,
        ) => {
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

          // 2. Register the subject user U whose history we will inspect.
          const { id: subjectId } = ctx.users.register({
            login: subjectLogin,
            password,
          });
          const subjectActor: AuthUser = { id: subjectId, role: Role.BUYER };

          // 3. For each combo, U reserves a seat on its OWN dedicated event
          //    (one reservation per user per event), then we apply the
          //    cancellations: participation first, event second — so combo 4
          //    yields a cancelled participation under a cancelled event.
          const combos = [...BASE_COMBOS, ...extraCombos];
          const expectations = new Map<
            string,
            {
              eventId: string;
              participationStatus: 'active' | 'cancelled';
              eventStatus: 'active' | 'cancelled';
            }
          >();

          for (const { cancelParticipation, cancelEvent } of combos) {
            const created = ctx.events.create(organizerActor, {
              title: 'History Separation Event',
              startDate,
              totalSeats: 2,
            } as CreateEventDto);

            const { reservationId } = ctx.reservations.reserve(
              subjectActor,
              created.id,
            );

            if (cancelParticipation) {
              ctx.reservations.cancel(subjectActor, reservationId);
            }
            if (cancelEvent) {
              // Owning organizer cancels the event; propagation flips the
              // event_status_snapshot for every reservation of that event.
              ctx.events.cancel(organizerActor, created.id);
            }

            expectations.set(reservationId, {
              eventId: created.id,
              participationStatus: cancelParticipation ? 'cancelled' : 'active',
              eventStatus: cancelEvent ? 'cancelled' : 'active',
            });
          }

          // 4. Fetch U's history through the service under test.
          const history = ctx.reservations.history(subjectActor);

          // 5a. Every reservation we created for U appears exactly once.
          expect(history.length).toBe(expectations.size);
          const byReservationId = new Map(
            history.map((entry) => [entry.reservationId, entry]),
          );
          expect(byReservationId.size).toBe(expectations.size);

          // 5b. Each entry reports participationStatus from the reservation's
          //     OWN status and eventStatus from the event-status snapshot,
          //     INDEPENDENTLY — verified against both our expectation and the
          //     persisted row in the database.
          for (const [reservationId, expected] of expectations) {
            const entry = byReservationId.get(reservationId);
            expect(entry).toBeDefined();
            expect(entry?.eventId).toBe(expected.eventId);
            expect(entry?.participationStatus).toBe(
              expected.participationStatus,
            );
            expect(entry?.eventStatus).toBe(expected.eventStatus);

            // Cross-check against the raw row: the two columns are distinct.
            const row = ctx.db.get<{
              status: string;
              event_status_snapshot: string;
            }>(
              'SELECT status, event_status_snapshot FROM reservations WHERE id = ?',
              [reservationId],
            );
            expect(row).toBeDefined();
            expect(entry?.participationStatus).toBe(row?.status);
            expect(entry?.eventStatus).toBe(row?.event_status_snapshot);
          }

          // 5c. The two statuses are reported SEPARATELY: there is at least one
          //     entry where the event is cancelled but U is still enrolled
          //     (participation active), and at least one where U cancelled but
          //     the event remains active. These prove neither status is derived
          //     from the other.
          const eventCancelledButEnrolled = history.some(
            (e) =>
              e.eventStatus === 'cancelled' &&
              e.participationStatus === 'active',
          );
          const optedOutButEventActive = history.some(
            (e) =>
              e.eventStatus === 'active' &&
              e.participationStatus === 'cancelled',
          );
          expect(eventCancelledButEnrolled).toBe(true);
          expect(optedOutButEventActive).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
