// Feature: event-ticket-reservation, Property 16: Invalid event creation input is rejected without persistence
//
// Property 16: For any event creation payload with a seat capacity that is
// non-integer, less than 1, or greater than 1,000,000, with a start date at or
// before the current server time, or with a missing required field, the request
// is rejected with HTTP 400 and no event record is persisted.
//
// The property is exercised at the HTTP boundary via supertest as an AUTHORIZED
// actor (an ORGANIZER): a freshly registered user is promoted to ORGANIZER by
// the seeded administrator and a valid JWT is minted for it. Authorizing the
// actor ensures the rejection comes from payload validation / the service
// (HTTP 400) and never from the role guard (HTTP 403). Each generated payload is
// valid in every respect except the single targeted aspect, so the 400 is
// attributable to that aspect alone. Before each request the current event row
// count is captured and re-checked afterwards to assert no event was persisted.
//
// Seat-capacity bounds and missing fields are caught by the ValidationPipe; a
// start date at/before now is caught either by the @IsFutureDate DTO validator
// or by EventsService — either way the request is rejected with HTTP 400.
//
// Validates: Requirements 7.4, 7.5, 7.6

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { AuthUser, Role } from '../../src/common/types';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** A start date safely in the future so the base payload is otherwise valid. */
const VALID_FUTURE_START = '2999-01-01T00:00:00.000Z';

/** A valid seat capacity (whole integer in [1, 1,000,000]). */
const validTotalSeats: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

/** A valid, non-empty event title. */
const validTitle: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 60 })
  .map((s) => `Property 16 ${s}`);

/** A complete, fully valid CreateEventDto body. */
function validBaseBody(): {
  title: string;
  description: string;
  startDate: string;
  totalSeats: number;
} {
  return {
    title: 'Property 16 Event',
    description: 'Invalid-creation probe',
    startDate: VALID_FUTURE_START,
    totalSeats: 250,
  };
}

/**
 * Seat capacity that is invalid in exactly one of the three ways the spec calls
 * out: non-integer, below the minimum (< 1), or above the maximum (> 1,000,000)
 * (Requirement 7.4).
 */
const invalidSeatCapacity: fc.Arbitrary<number> = fc.oneof(
  // Non-integer within the otherwise-allowed numeric range.
  fc
    .double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),
  // Less than one (zero and negatives).
  fc.integer({ min: -100_000, max: 0 }),
  // Greater than the maximum capacity.
  fc.integer({ min: 1_000_001, max: 5_000_000 }),
);

/**
 * A start date at or before the current server time: anywhere from "now" back
 * to roughly twenty years in the past, serialized as an ISO-8601 instant
 * (Requirement 7.5).
 */
const pastOrNowStartDate: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 20 * 365 * 24 * 60 * 60 * 1000 })
  .map((offsetMs) => new Date(Date.now() - offsetMs).toISOString());

/**
 * An otherwise-valid payload that violates exactly one acceptance-criterion
 * aspect, tagged with the requirement it targets for diagnostics.
 */
const invalidCreateEventBody: fc.Arbitrary<{
  body: Record<string, unknown>;
  reason: string;
}> = fc.oneof(
  // Req 7.4 — invalid seat capacity (non-integer / < 1 / > 1,000,000).
  fc.record({ title: validTitle, totalSeats: invalidSeatCapacity }).map(
    ({ title, totalSeats }) => ({
      body: {
        title,
        description: 'Invalid-creation probe',
        startDate: VALID_FUTURE_START,
        totalSeats,
      },
      reason: `7.4 invalid seat capacity (${totalSeats})`,
    }),
  ),
  // Req 7.5 — start date at or before now.
  fc.record({ title: validTitle, startDate: pastOrNowStartDate }).map(
    ({ title, startDate }) => ({
      body: {
        title,
        description: 'Invalid-creation probe',
        startDate,
        totalSeats: 250,
      },
      reason: `7.5 start date at/before now (${startDate})`,
    }),
  ),
  // Req 7.6 — a required field is omitted (title, startDate, or totalSeats).
  fc.constantFrom('title', 'startDate', 'totalSeats').map((omittedField) => {
    const body = validBaseBody() as Record<string, unknown>;
    delete body[omittedField];
    return { body, reason: `7.6 missing required field (${omittedField})` };
  }),
);

describe('Property 16: Invalid event creation input is rejected without persistence', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let adminActor: AuthUser;
  let organizerToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

    // The startup seed creates exactly one administrator; use it to promote a
    // freshly registered user to ORGANIZER.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminActor = { id: admin.id, role: Role.ADMINISTRATOR };

    // Register an organizer and mint an authorized bearer token for it so the
    // rejection is attributable to validation/service (400), never the role
    // guard (403).
    const { id: organizerId } = ctx.users.register({
      login: `${Date.now()}-organizer`,
      password: 'organizer-password',
    });
    ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
    organizerToken = jwtService.sign({
      sub: organizerId,
      role: Role.ORGANIZER,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects every invalid creation payload with HTTP 400 and persists no event', async () => {
    await fc.assert(
      fc.asyncProperty(invalidCreateEventBody, async ({ body }) => {
        // Baseline event count immediately before the request.
        const before = ctx.db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM events',
        );
        const beforeCount = before?.count ?? 0;

        const response = await request(ctx.app.getHttpServer())
          .post('/events')
          .set('Authorization', `Bearer ${organizerToken}`)
          .send(body);

        // The request is rejected with HTTP 400 (validation or service), never
        // a 403 (the actor is an authorized organizer) and never a 2xx.
        expect(response.status).toBe(400);

        // No event record was persisted: the row count is unchanged.
        const after = ctx.db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM events',
        );
        expect(after?.count ?? 0).toBe(beforeCount);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
