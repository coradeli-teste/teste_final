// Feature: event-ticket-reservation, Property 20: Unauthorized or repeated event cancellation is rejected without effect
//
// Property 20: For any event-cancellation attempt by an organizer who does not
// own the event the result is HTTP 403, and for any event already cancelled the
// result is HTTP 409; in both cases the event status is unchanged.
//
// Validates: Requirements 9.4, 9.7

import {
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';

import { AuthUser, Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two rejection scenarios for Property 20:
 *  - 'non-owner-organizer': a different organizer attempts to cancel the event
 *    (HTTP 403, Req 9.4); the event remains 'active'.
 *  - 'already-cancelled': the owner cancels once, then a second cancellation is
 *    attempted (HTTP 409, Req 9.7); the event remains 'cancelled'.
 *
 * For the repeat case we also vary whether the second attempt is made by the
 * owning organizer or by an administrator, since both must be rejected with 409.
 */
type RejectionCase =
  | { kind: 'non-owner-organizer' }
  | { kind: 'already-cancelled'; repeatActor: 'owner' | 'admin' };

const rejectionCase: fc.Arbitrary<RejectionCase> = fc.oneof(
  fc.constant<RejectionCase>({ kind: 'non-owner-organizer' }),
  fc
    .constantFrom<'owner' | 'admin'>('owner', 'admin')
    .map<RejectionCase>((repeatActor) => ({
      kind: 'already-cancelled',
      repeatActor,
    })),
);

describe('Property 20: Unauthorized or repeated event cancellation is rejected without effect', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Expected the seeded administrator to exist');
    }
    adminActor = { id: admin.id, role: admin.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** Register a fresh user and promote it to ORGANIZER via the seeded admin. */
  const createOrganizer = (): AuthUser => {
    const { id } = ctx.users.register({
      login: `org-${uuidv4()}`,
      password: 'valid-password-123',
    });
    ctx.users.changeRole(adminActor, id, Role.ORGANIZER);
    return { id, role: Role.ORGANIZER };
  };

  /** Create an active, future-dated event owned by `owner`. */
  const createEvent = (owner: AuthUser): string => {
    const view = ctx.events.create(owner, {
      title: 'Original Title',
      description: 'Original description',
      startDate: new Date(Date.now() + 30 * ONE_DAY_MS).toISOString(),
      totalSeats: 100,
    });
    return view.id;
  };

  /** Read the stored event status directly from the database. */
  const statusOf = (eventId: string): string | undefined =>
    ctx.db.get<{ status: string }>('SELECT status FROM events WHERE id = ?', [
      eventId,
    ])?.status;

  it('rejects non-owner (403) and repeated (409) cancellations and leaves the event status unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(rejectionCase, async (testCase) => {
        const owner = createOrganizer();
        const eventId = createEvent(owner);

        let actor: AuthUser;
        let expectedException:
          | typeof ForbiddenException
          | typeof ConflictException;
        let expectedStatus: number;
        let expectedStatusValue: string;

        if (testCase.kind === 'non-owner-organizer') {
          // Case A (Req 9.4): a different organizer attempts to cancel an event
          // they do not own -> 403, status stays 'active'.
          actor = createOrganizer();
          expectedException = ForbiddenException;
          expectedStatus = 403;
          expectedStatusValue = 'active';
        } else {
          // Case B (Req 9.7): owner cancels once, then a repeat attempt -> 409,
          // status stays 'cancelled' (unchanged by the rejected repeat).
          ctx.events.cancel(owner, eventId);
          expect(statusOf(eventId)).toBe('cancelled');
          actor = testCase.repeatActor === 'owner' ? owner : adminActor;
          expectedException = ConflictException;
          expectedStatus = 409;
          expectedStatusValue = 'cancelled';
        }

        // Snapshot the status immediately before the rejected attempt.
        const before = statusOf(eventId);

        let thrown: unknown;
        try {
          ctx.events.cancel(actor, eventId);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(expectedException);
        expect((thrown as HttpException).getStatus()).toBe(expectedStatus);

        const after = statusOf(eventId);
        expect(after).toBe(before);
        expect(after).toBe(expectedStatusValue);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
