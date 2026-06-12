// Feature: event-ticket-reservation, Property 19: Authorized cancellation soft-deletes the event
//
// Property 19: For any event, when cancelled by its owning organizer or by any
// administrator, the event's status becomes 'cancelled', the row continues to
// exist, and all non-status column values are preserved (the only other column
// allowed to change is updated_at).
//
// Validates: Requirements 9.1, 9.2

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
 * Produce a future ISO-8601 start date so event creation is never rejected by
 * the "start date must be in the future" guard. Offsets span 1..365 days ahead.
 */
const futureStartDateArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 365 })
  .map((days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  );

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

describe('Property 19: Authorized cancellation soft-deletes the event', () => {
  let ctx: TestAppContext;
  let seededAdmin: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup; resolve it to promote organizers
    // and to act as the administrative canceller (Req 9.2).
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    seededAdmin = { id: seeded!.id, role: seeded!.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('flips status to cancelled, keeps the row, and preserves all other columns', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        futureStartDateArbitrary,
        fc.integer({ min: 1, max: 1_000_000 }),
        // Whether the canceller is an administrator (Req 9.2) or the owning
        // organizer (Req 9.1).
        fc.boolean(),
        async (
          organizerLogin,
          organizerPassword,
          startDate,
          totalSeats,
          cancelByAdmin,
        ) => {
          // 1. Create an owning organizer: register, then promote via the admin.
          const { id: organizerId } = ctx.users.register({
            login: organizerLogin,
            password: organizerPassword,
          });
          ctx.users.changeRole(seededAdmin, organizerId, Role.ORGANIZER);
          const organizerActor: AuthUser = {
            id: organizerId,
            role: Role.ORGANIZER,
          };

          // 2. Create an event owned by that organizer.
          const createDto: CreateEventDto = {
            title: 'Cancellation Property Event',
            startDate,
            totalSeats,
          };
          const created = ctx.events.create(organizerActor, createDto);

          // 3. Snapshot the full row before cancelling.
          const before = ctx.db.get<RawEventRow>(
            'SELECT * FROM events WHERE id = ?',
            [created.id],
          );
          expect(before).toBeDefined();
          expect(before?.status).toBe('active');

          // 4. Cancel as either the owning organizer (Req 9.1) or the admin (Req 9.2).
          const canceller = cancelByAdmin ? seededAdmin : organizerActor;
          ctx.events.cancel(canceller, created.id);

          // 5. The row still exists and its status is now 'cancelled'.
          const after = ctx.db.get<RawEventRow>(
            'SELECT * FROM events WHERE id = ?',
            [created.id],
          );
          expect(after).toBeDefined();
          expect(after?.status).toBe('cancelled');

          // 6. Every non-status column is preserved (updated_at may change).
          expect(after?.id).toBe(before?.id);
          expect(after?.owner_id).toBe(before?.owner_id);
          expect(after?.title).toBe(before?.title);
          expect(after?.description).toBe(before?.description);
          expect(after?.start_date).toBe(before?.start_date);
          expect(after?.total_seats).toBe(before?.total_seats);
          expect(after?.remaining_seats).toBe(before?.remaining_seats);
          expect(after?.created_at).toBe(before?.created_at);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
