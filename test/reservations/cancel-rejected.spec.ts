// Feature: event-ticket-reservation, Property 28: Unauthorized or repeated reservation cancellation is rejected without seat change
//
// Property 28: For any reservation-cancellation attempt by a user who is not
// the owner the result is HTTP 403, and for any reservation already cancelled
// the result is HTTP 409; in both cases the reservation status and the event
// remaining_seats are unchanged (no double seat return).
//
// Validates: Requirements 12.3, 12.4

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
 * Two rejection scenarios for Property 28:
 *  - 'non-owner' (Req 12.3): a different buyer attempts to cancel buyer A's
 *    active reservation -> HTTP 403; reservation stays 'active' and the event's
 *    remaining_seats are unchanged.
 *  - 'already-cancelled' (Req 12.4): buyer A cancels their reservation once
 *    (returning the seat), then attempts to cancel again -> HTTP 409;
 *    reservation stays 'cancelled' and remaining_seats are unchanged (no double
 *    seat return).
 */
type RejectionCase = { kind: 'non-owner' } | { kind: 'already-cancelled' };

const rejectionCase: fc.Arbitrary<RejectionCase> = fc.oneof(
  fc.constant<RejectionCase>({ kind: 'non-owner' }),
  fc.constant<RejectionCase>({ kind: 'already-cancelled' }),
);

describe('Property 28: Unauthorized or repeated reservation cancellation is rejected without seat change', () => {
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

  /** Register a fresh BUYER and return its auth identity. */
  const createBuyer = (): AuthUser => {
    const { id } = ctx.users.register({
      login: `buyer-${uuidv4()}`,
      password: 'valid-password-123',
    });
    return { id, role: Role.BUYER };
  };

  /** Register a fresh user and promote it to ORGANIZER via the seeded admin. */
  const createOrganizer = (): AuthUser => {
    const { id } = ctx.users.register({
      login: `org-${uuidv4()}`,
      password: 'valid-password-123',
    });
    ctx.users.changeRole(adminActor, id, Role.ORGANIZER);
    return { id, role: Role.ORGANIZER };
  };

  /** Create an active, future-dated event owned by `owner` with >= 2 seats. */
  const createEvent = (owner: AuthUser): string => {
    const view = ctx.events.create(owner, {
      title: 'Original Title',
      description: 'Original description',
      startDate: new Date(Date.now() + 30 * ONE_DAY_MS).toISOString(),
      totalSeats: 100,
    });
    return view.id;
  };

  /** Read the stored reservation status directly from the database. */
  const reservationStatusOf = (reservationId: string): string | undefined =>
    ctx.db.get<{ status: string }>(
      'SELECT status FROM reservations WHERE id = ?',
      [reservationId],
    )?.status;

  /** Read the stored event remaining_seats directly from the database. */
  const remainingSeatsOf = (eventId: string): number | undefined =>
    ctx.db.get<{ remaining_seats: number }>(
      'SELECT remaining_seats FROM events WHERE id = ?',
      [eventId],
    )?.remaining_seats;

  it('rejects non-owner (403) and repeated (409) cancellations and leaves reservation status and remaining_seats unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(rejectionCase, async (testCase) => {
        // Setup: an organizer owns an event; buyer A reserves a seat.
        const owner = createOrganizer();
        const eventId = createEvent(owner);
        const buyerA = createBuyer();
        const { reservationId } = ctx.reservations.reserve(buyerA, eventId);

        // The reservation is active immediately after reserving.
        expect(reservationStatusOf(reservationId)).toBe('active');

        let actor: AuthUser;
        let expectedException:
          | typeof ForbiddenException
          | typeof ConflictException;
        let expectedStatus: number;
        let expectedStatusValue: string;

        if (testCase.kind === 'non-owner') {
          // Case A (Req 12.3): a different buyer attempts to cancel A's
          // reservation -> 403; reservation stays 'active'.
          actor = createBuyer();
          expectedException = ForbiddenException;
          expectedStatus = 403;
          expectedStatusValue = 'active';
        } else {
          // Case B (Req 12.4): buyer A cancels once (seat returned), then a
          // repeat attempt -> 409; reservation stays 'cancelled' and the seat
          // is NOT returned a second time.
          ctx.reservations.cancel(buyerA, reservationId);
          expect(reservationStatusOf(reservationId)).toBe('cancelled');
          actor = buyerA;
          expectedException = ConflictException;
          expectedStatus = 409;
          expectedStatusValue = 'cancelled';
        }

        // Snapshot reservation status and seats immediately before the rejected
        // attempt (after the first cancel in the already-cancelled case).
        const statusBefore = reservationStatusOf(reservationId);
        const seatsBefore = remainingSeatsOf(eventId);

        let thrown: unknown;
        try {
          ctx.reservations.cancel(actor, reservationId);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(expectedException);
        expect((thrown as HttpException).getStatus()).toBe(expectedStatus);

        // Reservation status and event remaining_seats are unchanged by the
        // rejected attempt (no double seat return).
        const statusAfter = reservationStatusOf(reservationId);
        const seatsAfter = remainingSeatsOf(eventId);

        expect(statusAfter).toBe(statusBefore);
        expect(statusAfter).toBe(expectedStatusValue);
        expect(seatsAfter).toBe(seatsBefore);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
