// Feature: event-ticket-reservation, Property 12: Malformed UUID route parameters are rejected
//
// Property 12: For any route parameter string that is not a well-formed UUID,
// the request to a UUID-parameterized route (event cancellation
// DELETE /events/:id, single-event read GET /events/:id, reservation creation
// POST /events/:id/reservations, reservation cancellation DELETE
// /reservations/:id) is rejected with HTTP 400 and the handler is not executed.
//
// This is asserted at the HTTP boundary with supertest, because ParseUUIDPipe
// runs at the route boundary (after the guards) and rejects malformed
// identifiers with HTTP 400 before the controller handler runs.
//
// Important interaction with the guard chain: in Nest, guards run BEFORE pipes.
// On the protected routes a malformed id sent with NO token would be rejected
// by JwtAuthGuard with 401, never reaching ParseUUIDPipe. To attribute the 400
// to the malformed UUID (and not to auth), every protected route is called with
// a VALID bearer token so the guard passes and the pipe is the only thing that
// can fail:
//   - DELETE /events/:id                 -> ADMINISTRATOR token (role guard passes)
//   - POST   /events/:id/reservations    -> authenticated BUYER token
//   - DELETE /reservations/:id           -> authenticated BUYER token
// GET /events/:id is public, so it always reaches the pipe with no token.
//
// A 400 (rather than 401/403/404/200/409) on each route confirms the handler
// never executed: a real handler would have produced a different status for a
// non-existent (but well-formed) identifier.
//
// Validates: Requirements 9.6, 10.4, 11.8, 12.6

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/**
 * General UUID shape (8-4-4-4-12 hex groups) used only as a NEGATIVE filter:
 * any generated candidate that happens to match this is discarded so the input
 * space contains exclusively malformed identifiers.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A single URL-path-safe character (letters, digits, hyphen). */
const safeChar = fc
  .integer({ min: 0, max: 36 })
  .map((n) =>
    n < 10
      ? String.fromCharCode(48 + n) // '0'..'9'
      : n < 36
        ? String.fromCharCode(97 + (n - 10)) // 'a'..'z'
        : '-',
  );

/** A run of URL-path-safe characters of the given length bounds. */
const safeString = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(safeChar, { minLength, maxLength }).map((cs) => cs.join(''));

/** Hex characters only, for building near-UUID-but-wrong-shape strings. */
const hexString = (length: number): fc.Arbitrary<string> =>
  fc
    .array(
      fc.integer({ min: 0, max: 15 }).map((n) => n.toString(16)),
      { minLength: length, maxLength: length },
    )
    .map((cs) => cs.join(''));

/**
 * fast-check generator for malformed (non-UUID) route-parameter strings,
 * covering several distinct failure shapes:
 *  - hand-picked obvious non-UUIDs ('abc', '123', ...),
 *  - random short/medium path-safe alphanumerics,
 *  - truncated UUIDs (a real UUID with its tail chopped off),
 *  - wrong-format hex groups (right alphabet, wrong segment lengths).
 *
 * A final filter removes anything that is empty or accidentally well-formed, so
 * every value is guaranteed to be a malformed UUID that still routes to the
 * `:id` segment.
 */
const malformedUuid: fc.Arbitrary<string> = fc
  .oneof(
    fc.constantFrom('abc', '123', 'not-a-uuid', 'x', '0', 'null', 'undefined'),
    safeString(1, 40),
    // Truncated UUID: keep a random non-empty prefix of a real v4 UUID.
    fc
      .tuple(
        fc.uuid(),
        fc.integer({ min: 1, max: 35 }),
      )
      .map(([id, keep]) => id.slice(0, keep)),
    // Wrong-format hex groups: valid hex alphabet, invalid 8-4-4-4-12 layout.
    fc
      .tuple(hexString(7), hexString(4), hexString(4), hexString(4), hexString(13))
      .map((groups) => groups.join('-')),
  )
  .filter((s) => s.length > 0 && !UUID_SHAPE.test(s));

describe('Property 12: Malformed UUID route parameters are rejected', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  /** Valid ADMINISTRATOR token so DELETE /events/:id passes the role guard. */
  let adminToken: string;
  /** Valid authenticated BUYER token for the reservation routes. */
  let buyerToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

    // The startup seed creates exactly one administrator.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminToken = jwtService.sign({ sub: admin.id, role: Role.ADMINISTRATOR });

    const buyer = ctx.users.register({
      login: `prop12-buyer-${Date.now()}`,
      password: 'valid-password-123',
    });
    buyerToken = jwtService.sign({ sub: buyer.id, role: Role.BUYER });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects malformed UUIDs with HTTP 400 on every UUID-parameterized route, never reaching the handler', async () => {
    await fc.assert(
      fc.asyncProperty(malformedUuid, async (badId) => {
        const server = ctx.app.getHttpServer();

        // GET /events/:id — public route, always reaches ParseUUIDPipe.
        const getEvent = await request(server).get(`/events/${badId}`);
        expect(getEvent.status).toBe(400);

        // DELETE /events/:id — ADMINISTRATOR token passes the role guard so the
        // pipe is the only failure point (400, not 401/403/404/409).
        const deleteEvent = await request(server)
          .delete(`/events/${badId}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(deleteEvent.status).toBe(400);

        // POST /events/:id/reservations — authenticated token passes the guard.
        const createReservation = await request(server)
          .post(`/events/${badId}/reservations`)
          .set('Authorization', `Bearer ${buyerToken}`)
          .send({});
        expect(createReservation.status).toBe(400);

        // DELETE /reservations/:id — authenticated token passes the guard.
        const cancelReservation = await request(server)
          .delete(`/reservations/${badId}`)
          .set('Authorization', `Bearer ${buyerToken}`);
        expect(cancelReservation.status).toBe(400);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Sanity check: a well-formed (but non-existent) UUID gets PAST ParseUUIDPipe,
  // so the handler runs and produces a non-400 status (404 for the read route).
  // This proves the 400s above are attributable to the malformed UUID and not
  // to the route being otherwise unreachable.
  it('lets a well-formed UUID pass the pipe on GET /events/:id (sanity check)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (goodId) => {
        const response = await request(ctx.app.getHttpServer()).get(
          `/events/${goodId}`,
        );
        // Reached the handler: not a 400 from the pipe. Unknown id -> 404.
        expect(response.status).not.toBe(400);
        expect(response.status).toBe(404);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
