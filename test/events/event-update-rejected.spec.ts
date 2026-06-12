// Feature: event-ticket-reservation, Property 18: Unauthorized or invalid event updates leave the event unchanged
//
// Property 18: For any update attempted by an organizer who does not own the
// event (HTTP 403), by an administrator modifying event data (HTTP 403), with a
// payload that fails validation (HTTP 400), with a start date at or before now
// (HTTP 400), or with a new total capacity below the reserved count (HTTP 400),
// the stored event data is unchanged.
//
// Validates: Requirements 8.2, 8.3, 8.5, 8.6, 8.7

import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

import { AuthUser, Role } from '../../src/common/types';
import { UpdateEventDto } from '../../src/dto';
import { asciiStringOfLength } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** A future ISO-8601 instant suitable for a valid event start date. */
const futureStartDate: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 3650 })
  .map((days) => new Date(Date.now() + days * ONE_DAY_MS).toISOString());

/** An ISO-8601 instant strictly before "now" (Requirement 8.6). */
const pastStartDate: fc.Arbitrary<string> = fc
  .integer({ min: 1000, max: 10_000_000_000 })
  .map((ms) => new Date(Date.now() - ms).toISOString());

/** A non-empty title for a valid (but unauthorized) update payload. */
const validTitle: fc.Arbitrary<string> = asciiStringOfLength(1, 40);

/** A fully valid update payload (rejected only by authorization, not validation). */
const validUpdate: fc.Arbitrary<UpdateEventDto> = fc.record({
  title: validTitle,
  totalSeats: fc.integer({ min: 1, max: 1_000_000 }),
  startDate: futureStartDate,
});

/**
 * A `reservedCount` of active reservations paired with a strictly-lower new
 * total capacity, so the update violates Requirement 8.7.
 */
const belowReserved: fc.Arbitrary<{ reservedCount: number; newTotal: number }> =
  fc.integer({ min: 2, max: 4 }).chain((reservedCount) =>
    fc.record({
      reservedCount: fc.constant(reservedCount),
      newTotal: fc.integer({ min: 1, max: reservedCount - 1 }),
    }),
  );

/**
 * Bodies that fail DTO validation at the HTTP layer (Requirement 8.5): a seat
 * capacity that is zero, negative, non-integer, or out of range; an empty
 * title; or a non-ISO start date.
 */
const invalidBody: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant<Record<string, unknown>>({ totalSeats: 0 }),
  fc.constant<Record<string, unknown>>({ totalSeats: -1 }),
  fc.constant<Record<string, unknown>>({ totalSeats: 1.5 }),
  fc.constant<Record<string, unknown>>({ totalSeats: 1_000_001 }),
  fc.constant<Record<string, unknown>>({ totalSeats: 'not-a-number' }),
  fc.constant<Record<string, unknown>>({ title: '' }),
  fc.constant<Record<string, unknown>>({ startDate: 'not-a-valid-date' }),
);

/** Discriminated description of one rejected-update scenario. */
type RejectionCase =
  | { kind: 'non-owner-organizer'; update: UpdateEventDto }
  | { kind: 'admin'; update: UpdateEventDto }
  | { kind: 'past-start'; pastStartDate: string }
  | { kind: 'below-reserved'; reservedCount: number; newTotal: number }
  | { kind: 'invalid-payload'; body: Record<string, unknown> };

/** Mix of all five rejection kinds — the "for any ..." disjunction of Property 18. */
const rejectionCase: fc.Arbitrary<RejectionCase> = fc.oneof(
  validUpdate.map<RejectionCase>((update) => ({
    kind: 'non-owner-organizer',
    update,
  })),
  validUpdate.map<RejectionCase>((update) => ({ kind: 'admin', update })),
  pastStartDate.map<RejectionCase>((d) => ({ kind: 'past-start', pastStartDate: d })),
  belowReserved.map<RejectionCase>((b) => ({ kind: 'below-reserved', ...b })),
  invalidBody.map<RejectionCase>((body) => ({ kind: 'invalid-payload', body })),
);

/** Raw event row, as stored, used for before/after equality assertions. */
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

describe('Property 18: Unauthorized or invalid event updates leave the event unchanged', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

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

  /** Register a fresh BUYER user (the default role on registration). */
  const createBuyer = (): AuthUser => {
    const { id } = ctx.users.register({
      login: `buyer-${uuidv4()}`,
      password: 'valid-password-123',
    });
    return { id, role: Role.BUYER };
  };

  /** Create an active, future-dated event owned by `owner` with `totalSeats`. */
  const createEvent = (owner: AuthUser, totalSeats: number): string => {
    const view = ctx.events.create(owner, {
      title: 'Original Title',
      description: 'Original description',
      startDate: new Date(Date.now() + 30 * ONE_DAY_MS).toISOString(),
      totalSeats,
    });
    return view.id;
  };

  /** Read the full stored event row for before/after comparison. */
  const snapshot = (eventId: string): RawEventRow | undefined =>
    ctx.db.get<RawEventRow>('SELECT * FROM events WHERE id = ?', [eventId]);

  it('rejects every unauthorized/invalid update and leaves the stored event unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(rejectionCase, async (testCase) => {
        const owner = createOrganizer();

        if (testCase.kind === 'invalid-payload') {
          // HTTP layer: the owner's own valid JWT, but a body that fails
          // DTO validation (Req 8.5). The ValidationPipe rejects it with 400
          // before the handler runs, so the stored event is untouched.
          const eventId = createEvent(owner, 100);
          const before = snapshot(eventId);

          const token = jwtService.sign({ sub: owner.id, role: Role.ORGANIZER });
          const response = await request(ctx.app.getHttpServer())
            .patch(`/events/${eventId}`)
            .set('Authorization', `Bearer ${token}`)
            .send(testCase.body);

          expect(response.status).toBe(400);

          const after = snapshot(eventId);
          expect(after).toEqual(before);
          return;
        }

        // Service-level cases: assert the exception type + HTTP status and that
        // the stored row is identical before/after the rejected attempt.
        let eventId: string;
        let actor: AuthUser;
        let dto: UpdateEventDto;
        let expectedException: typeof ForbiddenException | typeof BadRequestException;
        let expectedStatus: number;

        switch (testCase.kind) {
          case 'non-owner-organizer': {
            // A different organizer (does not own the event) -> 403 (Req 8.2).
            eventId = createEvent(owner, 100);
            actor = createOrganizer();
            dto = testCase.update;
            expectedException = ForbiddenException;
            expectedStatus = 403;
            break;
          }
          case 'admin': {
            // An administrator modifying event data -> 403 (Req 8.3).
            eventId = createEvent(owner, 100);
            actor = adminActor;
            dto = testCase.update;
            expectedException = ForbiddenException;
            expectedStatus = 403;
            break;
          }
          case 'past-start': {
            // Owner update with a start date at/before now -> 400 (Req 8.6).
            eventId = createEvent(owner, 100);
            actor = owner;
            dto = { startDate: testCase.pastStartDate };
            expectedException = BadRequestException;
            expectedStatus = 400;
            break;
          }
          case 'below-reserved': {
            // Make R active reservations, then the owner lowers the total
            // capacity below R -> 400 (Req 8.7).
            const { reservedCount, newTotal } = testCase;
            eventId = createEvent(owner, reservedCount + 5);
            for (let i = 0; i < reservedCount; i += 1) {
              ctx.reservations.reserve(createBuyer(), eventId);
            }
            actor = owner;
            dto = { totalSeats: newTotal };
            expectedException = BadRequestException;
            expectedStatus = 400;
            break;
          }
        }

        // Snapshot AFTER any reservations were made (Req 8.7 case), so the
        // comparison reflects the true pre-update stored state.
        const before = snapshot(eventId);

        let thrown: unknown;
        try {
          ctx.events.update(actor, eventId, dto);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(expectedException);
        expect((thrown as HttpException).getStatus()).toBe(expectedStatus);

        const after = snapshot(eventId);
        expect(after).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
