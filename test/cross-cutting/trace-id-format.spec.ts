// Feature: event-ticket-reservation, Property 31: Trace id is a 36-character UUID on every request
//
// Property 31: For every incoming request, the System assigns a Trace_Id
// formatted as a 36-character UUID to that request.
//
// This is exercised at the HTTP level via supertest over the running
// application. `TraceIdMiddleware` runs for every route (`forRoutes('*')`),
// assigns `req.traceId = uuidv4()`, and echoes it back on the response via the
// `X-Trace-Id` header (constant `TRACE_ID_HEADER`). The
// `ResponseTransformInterceptor` additionally embeds the same trace id in the
// success envelope `{ success, data, traceId, timestamp }`.
//
// To cover "every request" the generator varies the route, method, and body so
// that successful (200/201), client-error (400/401/404), and documentation
// responses are all produced. For each response we assert the `X-Trace-Id`
// header is a 36-character UUID string; where the body is the success envelope
// we additionally assert `body.traceId` is the same 36-character UUID.
//
// Validates: Requirements 14.1

import fc from 'fast-check';
import request from 'supertest';

import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 150;

/** Response header carrying the per-request trace id (see TraceIdMiddleware). */
const TRACE_ID_HEADER = 'x-trace-id';

/**
 * RFC-4122 UUID shape (36 characters: 8-4-4-4-12 hex with hyphens). The spec's
 * "36-character UUID" requirement is captured by both the length check and this
 * structural match.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Discriminated description of one request shape to exercise. Each shape lands
 * on a different point of the routing/lifecycle surface so the trace id is
 * verified across success and error responses alike.
 */
type RequestCase =
  | { kind: 'list-events' } // GET /events       -> 200 success envelope
  | { kind: 'docs' } // GET /docs               -> Swagger UI (non-envelope)
  | { kind: 'register'; login: string; password: string } // POST /auth/register
  | { kind: 'history-no-token' } // GET /reservations/me  -> 401 error envelope
  | { kind: 'not-found'; path: string }; // GET <unknown>  -> 404 error envelope

/** A URL-safe-ish random path segment for the not-found case. */
const pathSegment = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
  .filter((s) => s.length > 0);

/** Random register bodies: some valid, some invalid, to vary 201 vs 400. */
const registerCase: fc.Arbitrary<RequestCase> = fc.record({
  kind: fc.constant<'register'>('register'),
  // Login may be empty (invalid -> 400) or populated; uniqueness via a uuid-ish
  // suffix is unnecessary here because we only assert on the trace id.
  login: fc.string({ minLength: 0, maxLength: 40 }),
  // Password may be too short (invalid -> 400) or valid length.
  password: fc.string({ minLength: 0, maxLength: 40 }),
});

/** fast-check generator covering the five request shapes. */
const requestCase: fc.Arbitrary<RequestCase> = fc.oneof(
  fc.constant<RequestCase>({ kind: 'list-events' }),
  fc.constant<RequestCase>({ kind: 'docs' }),
  registerCase,
  fc.constant<RequestCase>({ kind: 'history-no-token' }),
  pathSegment.map<RequestCase>((path) => ({ kind: 'not-found', path: `/${path}-xyz` })),
);

describe('Property 31: Trace id is a 36-character UUID on every request', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** Issue the HTTP request described by `c` and return the supertest response. */
  const send = (c: RequestCase) => {
    const server = ctx.app.getHttpServer();
    switch (c.kind) {
      case 'list-events':
        return request(server).get('/events');
      case 'docs':
        return request(server).get('/docs');
      case 'register':
        return request(server)
          .post('/auth/register')
          .send({ login: c.login, password: c.password });
      case 'history-no-token':
        return request(server).get('/reservations/me');
      case 'not-found':
        return request(server).get(c.path);
    }
  };

  it('assigns a 36-character UUID trace id on the X-Trace-Id header of every response', async () => {
    await fc.assert(
      fc.asyncProperty(requestCase, async (c) => {
        const response = await send(c);

        // Every request, regardless of status, carries a trace id header set by
        // the middleware that runs for all routes.
        const headerTraceId = response.headers[TRACE_ID_HEADER];
        expect(typeof headerTraceId).toBe('string');
        expect(headerTraceId.length).toBe(36);
        expect(headerTraceId).toMatch(UUID_RE);

        // Where the response is the standard success envelope, the embedded
        // traceId must be present, 36 chars, and equal to the header value.
        const body = response.body as { success?: unknown; traceId?: unknown };
        if (body && body.success === true && typeof body.traceId === 'string') {
          expect(body.traceId.length).toBe(36);
          expect(body.traceId).toMatch(UUID_RE);
          expect(body.traceId).toBe(headerTraceId);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
