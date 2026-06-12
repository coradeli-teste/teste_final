// Feature: event-ticket-reservation, Property 33: Successful responses are wrapped in the standard envelope
//
// Property 33: For any successful response, the ResponseTransformInterceptor
// wraps the handler payload in the standard envelope
// `{ success: true, data, traceId, timestamp }`.
//
// This is exercised at the HTTP level via supertest over the running
// application. The interceptor runs globally, so every 2xx response should
// share the same envelope shape regardless of which handler produced it. To
// cover many success shapes the generator (fc.oneof) varies the route so that
// the following SUCCESS responses are produced:
//   - POST /auth/register (201)            -> data: { id }
//   - POST /auth/login (200)               -> data: { accessToken }
//   - GET  /events (200)                   -> data: EventView[]
//   - GET  /reservations/me (200)          -> data: ReservationHistoryEntry[]
//   - POST /events (201, ORGANIZER token)  -> data: EventView
//
// For each successful response we assert: success === true; a `data` property
// is present and matches the handler's payload shape; `traceId` is a
// 36-character UUID string; and `timestamp` is a valid ISO-8601 instant that
// round-trips through `new Date(...).toISOString()`.
//
// Validates: Requirements 14.5

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { AuthUser, Role } from '../../src/common/types';
import { uniqueValidLogin, validPasswordArbitrary } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** RFC-4122 UUID shape (36 characters: 8-4-4-4-12 hex with hyphens). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Discriminated description of one SUCCESS request shape to exercise. Each
 * shape lands on a different handler so the envelope is verified across many
 * distinct `data` payload shapes (object, token, array, single view).
 */
type SuccessCase =
  | { kind: 'register'; login: string; password: string }
  | { kind: 'login'; login: string; password: string }
  | { kind: 'list-events' }
  | { kind: 'history-me' }
  | { kind: 'create-event'; title: string; startDate: string; totalSeats: number };

/**
 * A strictly-future ISO-8601 instant for event creation. The minimum offset is
 * one hour so the start date is still in the future by the time the request is
 * validated (a tiny offset could elapse before the handler runs).
 */
const futureStartDate: fc.Arbitrary<string> = fc
  .integer({ min: 3_600_000, max: 10_000_000_000 })
  .map((ms) => new Date(Date.now() + ms).toISOString());

/** Valid total seat capacity within the DTO bounds [1, 1,000,000]. */
const totalSeats: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });

/** Assert a value is a valid ISO-8601 timestamp that round-trips. */
const assertIsoTimestamp = (value: unknown): void => {
  expect(typeof value).toBe('string');
  const ms = Date.parse(value as string);
  expect(Number.isFinite(ms)).toBe(true);
  // Round-trips through the Date -> ISO conversion the interceptor uses.
  expect(new Date(value as string).toISOString()).toBe(value);
};

describe('Property 33: Successful responses are wrapped in the standard envelope', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

    // The startup seed creates exactly one administrator; use it to promote
    // freshly registered users to ORGANIZER so they can create events.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminActor = { id: admin.id, role: Role.ADMINISTRATOR };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /**
   * Register a fresh user, optionally promote it to {@link role}, and mint a
   * valid bearer token carrying that role for use over supertest. Logins are
   * unique to avoid the active-login 409 conflict.
   */
  const mintToken = (role: Role): string => {
    const login = `${Date.now()}-${Math.random().toString(36).slice(2)}-envelope`;
    const password = 'envelope-pass-123';
    const { id } = ctx.users.register({ login, password });
    if (role !== Role.BUYER) {
      ctx.users.changeRole(adminActor, id, role);
    }
    return jwtService.sign({ sub: id, role });
  };

  /**
   * fast-check generator covering the five SUCCESS request shapes. Logins are
   * made unique per case so register/login never hit a 409.
   */
  const successCase: fc.Arbitrary<SuccessCase> = fc.oneof(
    fc
      .tuple(uniqueValidLogin, validPasswordArbitrary)
      .map<SuccessCase>(([login, password]) => ({ kind: 'register', login, password })),
    fc
      .tuple(uniqueValidLogin, validPasswordArbitrary)
      .map<SuccessCase>(([login, password]) => ({ kind: 'login', login, password })),
    fc.constant<SuccessCase>({ kind: 'list-events' }),
    fc.constant<SuccessCase>({ kind: 'history-me' }),
    fc
      .tuple(uniqueValidLogin, futureStartDate, totalSeats)
      .map<SuccessCase>(([title, startDate, seats]) => ({
        kind: 'create-event',
        title: `evt-${title}`.slice(0, 120),
        startDate,
        totalSeats: seats,
      })),
  );

  /**
   * Issue the HTTP request described by `c`, performing any required setup
   * (pre-registering a user before login, minting a token for protected
   * routes), and return the resolved supertest response.
   */
  const send = async (c: SuccessCase) => {
    const server = ctx.app.getHttpServer();
    switch (c.kind) {
      case 'register':
        return request(server)
          .post('/auth/register')
          .send({ login: c.login, password: c.password });
      case 'login': {
        // Register first so the credentials resolve to a 200 login.
        await request(server)
          .post('/auth/register')
          .send({ login: c.login, password: c.password });
        return request(server)
          .post('/auth/login')
          .send({ login: c.login, password: c.password });
      }
      case 'list-events':
        return request(server).get('/events');
      case 'history-me': {
        const token = mintToken(Role.BUYER);
        return request(server)
          .get('/reservations/me')
          .set('Authorization', `Bearer ${token}`);
      }
      case 'create-event': {
        const token = mintToken(Role.ORGANIZER);
        return request(server)
          .post('/events')
          .set('Authorization', `Bearer ${token}`)
          .send({ title: c.title, startDate: c.startDate, totalSeats: c.totalSeats });
      }
    }
  };

  /** Assert the `data` payload matches the shape produced by the handler. */
  const assertDataShape = (c: SuccessCase, data: unknown): void => {
    switch (c.kind) {
      case 'register': {
        const d = data as { id?: unknown };
        expect(typeof d.id).toBe('string');
        expect((d.id as string).length).toBe(36);
        break;
      }
      case 'login': {
        const d = data as { accessToken?: unknown };
        expect(typeof d.accessToken).toBe('string');
        expect((d.accessToken as string).length).toBeGreaterThan(0);
        break;
      }
      case 'list-events':
      case 'history-me':
        expect(Array.isArray(data)).toBe(true);
        break;
      case 'create-event': {
        const d = data as { id?: unknown; status?: unknown; soldOut?: unknown };
        expect(typeof d.id).toBe('string');
        expect(d.status).toBe('active');
        expect(typeof d.soldOut).toBe('boolean');
        break;
      }
    }
  };

  it('wraps every successful response in { success: true, data, traceId, timestamp }', async () => {
    await fc.assert(
      fc.asyncProperty(successCase, async (c) => {
        const response = await send(c);

        // Sanity: the case must actually produce a 2xx so we are asserting on
        // the SUCCESS envelope (not an error envelope).
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(300);

        const body = response.body as {
          success?: unknown;
          data?: unknown;
          traceId?: unknown;
          timestamp?: unknown;
        };

        // success === true
        expect(body.success).toBe(true);

        // a `data` property exists and matches the handler's payload shape
        expect(body).toHaveProperty('data');
        assertDataShape(c, body.data);

        // traceId is a 36-character UUID string
        expect(typeof body.traceId).toBe('string');
        expect((body.traceId as string).length).toBe(36);
        expect(body.traceId).toMatch(UUID_RE);

        // timestamp is a valid ISO-8601 string that round-trips
        assertIsoTimestamp(body.timestamp);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
