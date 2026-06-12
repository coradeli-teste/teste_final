// Feature: event-ticket-reservation, Task 18.2: Integration tests for end-to-end flows
//
// These are INTEGRATION tests (supertest against the running Nest application),
// not property-based tests. They exercise representative happy-path and error
// flows through the FULL request lifecycle chain
// (TraceIdMiddleware -> RequestLoggerMiddleware -> JwtAuthGuard -> RolesGuard
//  -> ParseUUIDPipe/ValidationPipe -> handler -> TimeoutInterceptor
//  -> ResponseTransformInterceptor -> AllExceptionsFilter), asserting:
//
//   1. The status codes of each step of a complete domain flow
//      (register -> login -> promote -> create event -> list -> reserve ->
//       history -> cancel reservation -> cancel event).
//   2. The standard SUCCESS envelope `{ success, data, traceId, timestamp }`
//      on success responses (Requirement 14.5).
//   3. The standard ERROR envelope `{ success, error, traceId, timestamp }`
//      on failures.
//   4. Guard precedence on a protected route that ALSO has a body DTO
//      (POST /events): guards (401/403) take precedence over body validation
//      (400). With no token + invalid body -> 401; with an insufficient-role
//      token + invalid body -> 403; with a valid authorized token + invalid
//      body -> 400. This demonstrates guards run before the ValidationPipe.
//
// Validates: Requirements 3.3, 3.5, 14.5

import { HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

import { Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** A future ISO-8601 instant (one year out) for valid event creation. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const futureIso = (): string => new Date(Date.now() + ONE_YEAR_MS).toISOString();

/** A globally unique login within the 1–254 character bound. */
const uniqueLogin = (prefix: string): string =>
  `${prefix}-${uuidv4()}-${Date.now()}`.slice(0, 254);

/** Default valid password (8–128 chars). */
const VALID_PASSWORD = 'valid-password-123';

/**
 * Assert the standard SUCCESS envelope shape (Requirement 14.5):
 * `{ success: true, data, traceId, timestamp }`, where traceId is the
 * 36-character UUID assigned by TraceIdMiddleware and timestamp is ISO-8601.
 */
const expectSuccessEnvelope = (
  body: unknown,
  options: { requireData?: boolean } = {},
): Record<string, unknown> => {
  const { requireData = true } = options;
  const envelope = body as Record<string, unknown>;
  expect(envelope.success).toBe(true);
  // Handlers that return a value carry `data`; void-returning handlers (role
  // change, cancellations) produce an envelope whose `data` is undefined and is
  // dropped during JSON serialization — assert presence only where data is due.
  if (requireData) {
    expect(envelope).toHaveProperty('data');
  }
  // traceId is set by the middleware for every request that reaches a handler.
  expect(typeof envelope.traceId).toBe('string');
  expect((envelope.traceId as string).length).toBe(36);
  expect(typeof envelope.timestamp).toBe('string');
  expect(Number.isNaN(Date.parse(envelope.timestamp as string))).toBe(false);
  return envelope;
};

/**
 * Assert the standard ERROR envelope shape:
 * `{ success: false, error, traceId, timestamp }`. The error payload carries a
 * numeric statusCode and a message (string or per-field array).
 */
const expectErrorEnvelope = (
  body: unknown,
  expectedStatus: number,
): Record<string, unknown> => {
  const envelope = body as Record<string, unknown>;
  expect(envelope.success).toBe(false);
  expect(envelope).toHaveProperty('error');
  const error = envelope.error as Record<string, unknown>;
  expect(error.statusCode).toBe(expectedStatus);
  expect(error).toHaveProperty('message');
  expect(typeof envelope.traceId).toBe('string');
  expect((envelope.traceId as string).length).toBe(36);
  expect(typeof envelope.timestamp).toBe('string');
  expect(Number.isNaN(Date.parse(envelope.timestamp as string))).toBe(false);
  // No stack traces or SQL leak into the error payload.
  expect(envelope).not.toHaveProperty('stack');
  return envelope;
};

describe('Task 18.2: end-to-end integration flows through the full chain', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('runs the full happy-path lifecycle and wraps every success in the standard envelope', async () => {
    // --- 1. Register a buyer (POST /auth/register -> 201, data.id) ----------
    const buyerLogin = uniqueLogin('buyer');
    const registerBuyer = await request(server)
      .post('/auth/register')
      .send({ login: buyerLogin, password: VALID_PASSWORD });
    expect(registerBuyer.status).toBe(HttpStatus.CREATED);
    const buyerReg = expectSuccessEnvelope(registerBuyer.body);
    const buyerData = buyerReg.data as { id: string };
    expect(typeof buyerData.id).toBe('string');
    const buyerId = buyerData.id;

    // --- 2. Login the buyer (POST /auth/login -> 200, data.accessToken) -----
    const loginBuyer = await request(server)
      .post('/auth/login')
      .send({ login: buyerLogin, password: VALID_PASSWORD });
    expect(loginBuyer.status).toBe(HttpStatus.OK);
    const buyerLoginEnv = expectSuccessEnvelope(loginBuyer.body);
    const buyerToken = (buyerLoginEnv.data as { accessToken: string }).accessToken;
    expect(typeof buyerToken).toBe('string');

    // --- 3. Register a user to be promoted to ORGANIZER ---------------------
    const organizerLogin = uniqueLogin('organizer');
    const registerOrg = await request(server)
      .post('/auth/register')
      .send({ login: organizerLogin, password: VALID_PASSWORD });
    expect(registerOrg.status).toBe(HttpStatus.CREATED);
    const organizerId = (expectSuccessEnvelope(registerOrg.body).data as {
      id: string;
    }).id;

    // --- 3b. Promote that user to ORGANIZER as the seeded administrator -----
    const adminLogin = await request(server)
      .post('/auth/login')
      .send({ login: 'administrator', password: 'administrator' });
    expect(adminLogin.status).toBe(HttpStatus.OK);
    const adminToken = (expectSuccessEnvelope(adminLogin.body).data as {
      accessToken: string;
    }).accessToken;

    const promote = await request(server)
      .patch(`/users/${organizerId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.ORGANIZER });
    expect(promote.status).toBe(HttpStatus.OK);
    expectSuccessEnvelope(promote.body, { requireData: false });
    // The promotion persisted in the database.
    const promotedRow = ctx.db.get<{ role: number }>(
      'SELECT role FROM users WHERE id = ?',
      [organizerId],
    );
    expect(promotedRow?.role).toBe(Role.ORGANIZER);

    // Login the organizer AFTER promotion so the token carries the new role.
    const organizerLoginRes = await request(server)
      .post('/auth/login')
      .send({ login: organizerLogin, password: VALID_PASSWORD });
    expect(organizerLoginRes.status).toBe(HttpStatus.OK);
    const organizerToken = (expectSuccessEnvelope(organizerLoginRes.body).data as {
      accessToken: string;
    }).accessToken;

    // --- 4. Organizer creates an event (POST /events -> 201, EventView) -----
    const totalSeats = 5;
    const createEvent = await request(server)
      .post('/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Integration E2E Concert',
        description: 'A full-chain integration test event.',
        startDate: futureIso(),
        totalSeats,
      });
    expect(createEvent.status).toBe(HttpStatus.CREATED);
    const eventView = expectSuccessEnvelope(createEvent.body).data as {
      id: string;
      totalSeats: number;
      remainingSeats: number;
      status: string;
      soldOut: boolean;
    };
    const eventId = eventView.id;
    expect(typeof eventId).toBe('string');
    expect(eventView.totalSeats).toBe(totalSeats);
    expect(eventView.remainingSeats).toBe(totalSeats);
    expect(eventView.status).toBe('active');
    expect(eventView.soldOut).toBe(false);

    // --- 5. List events (GET /events -> 200, array contains the event) ------
    const listRes = await request(server).get('/events');
    expect(listRes.status).toBe(HttpStatus.OK);
    const list = expectSuccessEnvelope(listRes.body).data as Array<{ id: string }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((e) => e.id === eventId)).toBe(true);

    // --- 6. Buyer reserves a seat -------------------------------------------
    const reserveRes = await request(server)
      .post(`/events/${eventId}/reservations`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({});
    expect(reserveRes.status).toBe(HttpStatus.CREATED);
    const reservation = expectSuccessEnvelope(reserveRes.body).data as {
      reservationId: string;
      remainingSeats: number;
    };
    expect(typeof reservation.reservationId).toBe('string');
    // One seat consumed atomically.
    expect(reservation.remainingSeats).toBe(totalSeats - 1);
    const reservationId = reservation.reservationId;

    // --- 7. Buyer views history (GET /reservations/me -> 200, has the resv) -
    const historyRes = await request(server)
      .get('/reservations/me')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(historyRes.status).toBe(HttpStatus.OK);
    const history = expectSuccessEnvelope(historyRes.body).data as Array<{
      reservationId: string;
      eventId: string;
      participationStatus: string;
    }>;
    expect(Array.isArray(history)).toBe(true);
    const entry = history.find((h) => h.reservationId === reservationId);
    expect(entry).toBeDefined();
    expect(entry?.eventId).toBe(eventId);
    expect(entry?.participationStatus).toBe('active');

    // --- 8. Buyer cancels the reservation (DELETE -> 200) and seat returns --
    const cancelReservation = await request(server)
      .delete(`/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(cancelReservation.status).toBe(HttpStatus.OK);
    expectSuccessEnvelope(cancelReservation.body, { requireData: false });

    // The seat returned: reading the event shows full capacity again.
    const afterCancel = await request(server).get(`/events/${eventId}`);
    expect(afterCancel.status).toBe(HttpStatus.OK);
    const afterEvent = expectSuccessEnvelope(afterCancel.body).data as {
      remainingSeats: number;
    };
    expect(afterEvent.remainingSeats).toBe(totalSeats);

    // --- 9. Organizer cancels the event (DELETE /events/:id -> 200) ---------
    const cancelEvent = await request(server)
      .delete(`/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(cancelEvent.status).toBe(HttpStatus.OK);
    expectSuccessEnvelope(cancelEvent.body, { requireData: false });

    // The cancelled event no longer appears in the active listing.
    const listAfterCancel = await request(server).get('/events');
    expect(listAfterCancel.status).toBe(HttpStatus.OK);
    const listAfter = expectSuccessEnvelope(listAfterCancel.body).data as Array<{
      id: string;
    }>;
    expect(listAfter.some((e) => e.id === eventId)).toBe(false);
  });

  describe('guard precedence over body validation on POST /events (Req 3.3, 3.5, 14.4)', () => {
    // An invalid body for CreateEventDto: missing title, non-future date,
    // out-of-range seats. If validation ran first it would yield 400; the guard
    // chain must intercept the request before the ValidationPipe.
    const invalidBody = {
      title: '',
      startDate: '2000-01-01T00:00:00.000Z',
      totalSeats: -10,
    };

    let buyerToken: string;
    let organizerToken: string;

    beforeAll(async () => {
      // A BUYER (insufficient role for POST /events).
      const buyerLogin = uniqueLogin('precedence-buyer');
      await request(server)
        .post('/auth/register')
        .send({ login: buyerLogin, password: VALID_PASSWORD });
      const buyerLoginRes = await request(server)
        .post('/auth/login')
        .send({ login: buyerLogin, password: VALID_PASSWORD });
      buyerToken = buyerLoginRes.body.data.accessToken;

      // An ORGANIZER (authorized for POST /events), promoted by the admin.
      const orgLogin = uniqueLogin('precedence-org');
      const orgReg = await request(server)
        .post('/auth/register')
        .send({ login: orgLogin, password: VALID_PASSWORD });
      const orgId = orgReg.body.data.id;
      const adminLoginRes = await request(server)
        .post('/auth/login')
        .send({ login: 'administrator', password: 'administrator' });
      const adminToken = adminLoginRes.body.data.accessToken;
      await request(server)
        .patch(`/users/${orgId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: Role.ORGANIZER });
      const orgLoginRes = await request(server)
        .post('/auth/login')
        .send({ login: orgLogin, password: VALID_PASSWORD });
      organizerToken = orgLoginRes.body.data.accessToken;
    });

    it('returns 401 when NO token is sent (auth guard wins over body validation)', async () => {
      const res = await request(server).post('/events').send(invalidBody);
      // JwtAuthGuard rejects before the ValidationPipe ever sees the body.
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expectErrorEnvelope(res.body, HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 when an insufficient-role (BUYER) token is sent with an invalid body (role guard wins over body validation)', async () => {
      const res = await request(server)
        .post('/events')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send(invalidBody);
      // RolesGuard rejects before the ValidationPipe ever sees the body.
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expectErrorEnvelope(res.body, HttpStatus.FORBIDDEN);
    });

    it('returns 400 only when a valid authorized (ORGANIZER) token is sent with an invalid body (guards pass, validation runs)', async () => {
      const res = await request(server)
        .post('/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(invalidBody);
      // Guards passed; now the ValidationPipe rejects the malformed body.
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      const envelope = expectErrorEnvelope(res.body, HttpStatus.BAD_REQUEST);
      // Per-field validation messages are preserved (Req 14.4).
      const message = (envelope.error as { message: string | string[] }).message;
      expect(Array.isArray(message)).toBe(true);
    });
  });
});
