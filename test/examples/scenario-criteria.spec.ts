// Example/unit tests for scenario-specific acceptance criteria (Task 18.1).
//
// These are focused, deterministic example tests (not property-based) that
// cover the time/log/side-effect/fault-injection criteria the design assigns
// to example tests rather than properties:
//
//   - Req 2.1   Login completes within 2 seconds; token signed against the
//               configured JWT secret.
//   - Req 2.5/  Missing/empty signing secret -> service-unavailable branch
//     2.6       (HTTP 503) with no token issued.
//   - Req 3.1   JwtAuthGuard extracts the bearer token: a valid token reaches
//               the protected handler (200); a missing/garbled header is blocked
//               (401) before the handler runs.
//   - Req 6.5   Profile-persistence failure path: a persistence fault surfaces
//               as an error and leaves the stored data unchanged.
//   - Req 12.2  Atomic reservation-cancel rollback under fault injection: a
//               fault during the seat increment rolls back the whole
//               transaction (reservation stays active, seats unchanged).
//   - Req 14.2  A single request logger entry carries the method, path, and
//               trace id.
//   - Req 14.3  DTO validation runs before the handler: an invalid payload is
//               rejected (400) and the handler's side effect never occurs.
//
// The 30-second timeout criterion (Req 14.6) is covered by the companion unit
// test in `timeout-interceptor.spec.ts`.

import {
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';

import { AuthService } from '../../src/auth/auth.service';
import { UsersService } from '../../src/users/users.service';
import { AuthUser, Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** A future ISO-8601 instant so events are never blocked by the start-date guard. */
const futureDate = (): string =>
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

describe('Scenario-specific criteria (example/unit tests)', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let configuredSecret: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);
    configuredSecret =
      ctx.getService(ConfigService).get<string>('JWT_SECRET') ?? '';
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 1. Login within 2 seconds + signature against the configured secret (Req 2.1)
  // ---------------------------------------------------------------------------
  describe('Req 2.1 — login is fast and the token verifies against the configured secret', () => {
    it('issues a token in well under 2000ms that verifies with the configured JWT_SECRET', () => {
      const login = `fast-login-${Date.now()}`;
      const password = 'valid-password-123';
      ctx.users.register({ login, password });

      const start = process.hrtime.bigint();
      const { accessToken } = ctx.auth.login({ login, password });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

      // Login must complete within the 2-second budget (Req 2.1).
      expect(elapsedMs).toBeLessThan(2000);

      // The issued token verifies against the configured secret; verifying with
      // a wrong secret would throw, so a successful verify proves the signature.
      const payload = jwtService.verify<{ sub: string; role: number }>(
        accessToken,
        { secret: configuredSecret },
      );
      expect(typeof payload.sub).toBe('string');
      expect(payload.role).toBe(Role.BUYER);

      // A token tampered/signed with a different secret must NOT verify against
      // the configured one, confirming the binding to JWT_SECRET.
      expect(() =>
        jwtService.verify(accessToken, {
          secret: `${configuredSecret}-WRONG`,
        }),
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Header extraction reaches/blocks the handler (Req 3.1)
  // ---------------------------------------------------------------------------
  describe('Req 3.1 — JwtAuthGuard extracts the bearer token from the Authorization header', () => {
    const PROTECTED_ROUTE = '/reservations/me';

    it('lets a valid Bearer token reach the protected handler (200)', async () => {
      const { id } = ctx.users.register({
        login: `hdr-ok-${Date.now()}`,
        password: 'valid-password-123',
      });
      const token = jwtService.sign({ sub: id, role: Role.BUYER });

      const response = await request(ctx.app.getHttpServer())
        .get(PROTECTED_ROUTE)
        .set('Authorization', `Bearer ${token}`);

      // The handler ran: history returns 200 with the standard success envelope.
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true });
    });

    it('blocks a request with no Authorization header (401) before the handler', async () => {
      const response = await request(ctx.app.getHttpServer()).get(
        PROTECTED_ROUTE,
      );
      expect(response.status).toBe(401);
    });

    it('blocks a request with a garbled Authorization header (401) before the handler', async () => {
      const response = await request(ctx.app.getHttpServer())
        .get(PROTECTED_ROUTE)
        .set('Authorization', 'NotBearer garbage.token.value');
      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Single log entry with method + path (Req 14.2)
  // ---------------------------------------------------------------------------
  describe('Req 14.2 — the request logger emits a single entry with method, path, and trace id', () => {
    it('logs exactly one entry of the form "[<uuid>] GET /events" per request', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      try {
        await request(ctx.app.getHttpServer()).get('/events');

        // Match the RequestLoggerMiddleware format: a 36-char UUID trace id, the
        // HTTP method, and the route path in a single entry.
        const pattern =
          /^\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\] GET \/events/;
        const matching = logSpy.mock.calls.filter(
          (callArgs) =>
            typeof callArgs[0] === 'string' && pattern.test(callArgs[0]),
        );

        // Exactly one request-logger entry for this request (Req 14.2).
        expect(matching).toHaveLength(1);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 7. DTO validation runs before the handler (Req 14.3)
  // ---------------------------------------------------------------------------
  describe('Req 14.3 — the ValidationPipe rejects an invalid DTO before the handler runs', () => {
    it('rejects an invalid CreateEventDto with 400 and creates no event row', async () => {
      // Authenticate as the seeded administrator (allowed to POST /events) so the
      // request passes the guards and reaches the body ValidationPipe.
      const admin = ctx.users.findByLogin('administrator');
      expect(admin).toBeDefined();
      const token = jwtService.sign({
        sub: admin!.id,
        role: Role.ADMINISTRATOR,
      });

      const before = ctx.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM events',
      );

      // Invalid on every field: empty title, non-integer/negative seats, bad date.
      const response = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '', totalSeats: -5, startDate: 'not-a-date' });

      expect(response.status).toBe(400);

      // The handler never executed: no event was persisted (side effect absent).
      const after = ctx.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM events',
      );
      expect(after?.count).toBe(before?.count);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Profile-persistence failure path (Req 6.5)
  // ---------------------------------------------------------------------------
  describe('Req 6.5 — a persistence failure during profile update leaves stored data unchanged', () => {
    it('surfaces the error and preserves the original row when the UPDATE fails', () => {
      const login = `persist-fail-${Date.now()}`;
      const password = 'original-password-1';
      const { id } = ctx.users.register({ login, password });
      const actor: AuthUser = { id, role: Role.BUYER };

      const before = ctx.db.get<{ login: string; password: string }>(
        'SELECT login, password FROM users WHERE id = ?',
        [id],
      );
      expect(before).toBeDefined();

      // Inject a persistence fault on the single UPDATE the profile update runs.
      const runSpy = jest
        .spyOn(ctx.db, 'run')
        .mockImplementationOnce(() => {
          throw new Error('injected disk I/O error');
        });

      try {
        // The error propagates to the caller (mapped to a 5xx by the global
        // filter in the HTTP path).
        expect(() =>
          ctx.users.updateOwnProfile(actor, id, {
            login: `${login}-changed`,
            password: 'changed-password-2',
          }),
        ).toThrow('injected disk I/O error');
      } finally {
        runSpy.mockRestore();
      }

      // The stored personal data is unchanged after the failed update (Req 6.5).
      const after = ctx.db.get<{ login: string; password: string }>(
        'SELECT login, password FROM users WHERE id = ?',
        [id],
      );
      expect(after?.login).toBe(before?.login);
      expect(after?.password).toBe(before?.password);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Atomic reservation-cancel rollback via fault injection (Req 12.2)
  // ---------------------------------------------------------------------------
  describe('Req 12.2 — a fault during reservation cancellation rolls back the whole transaction', () => {
    it('rolls back so the reservation stays active and the event seats are unchanged', () => {
      // Build an organizer-owned, future event with capacity 5.
      const admin = ctx.users.findByLogin('administrator')!;
      const adminActor: AuthUser = { id: admin.id, role: Role.ADMINISTRATOR };

      const organizerLogin = `cancel-rollback-org-${Date.now()}`;
      const { id: organizerId } = ctx.users.register({
        login: organizerLogin,
        password: 'valid-password-123',
      });
      ctx.users.changeRole(adminActor, organizerId, Role.ORGANIZER);
      const organizer: AuthUser = { id: organizerId, role: Role.ORGANIZER };

      const event = ctx.events.create(organizer, {
        title: 'Rollback Event',
        startDate: futureDate(),
        totalSeats: 5,
      });

      // A buyer reserves one seat (remaining 5 -> 4).
      const { id: buyerId } = ctx.users.register({
        login: `cancel-rollback-buyer-${Date.now()}`,
        password: 'valid-password-123',
      });
      const buyer: AuthUser = { id: buyerId, role: Role.BUYER };
      const { reservationId } = ctx.reservations.reserve(buyer, event.id);

      const beforeReservation = ctx.db.get<{ status: string }>(
        'SELECT status FROM reservations WHERE id = ?',
        [reservationId],
      );
      const beforeEvent = ctx.db.get<{ remaining_seats: number }>(
        'SELECT remaining_seats FROM events WHERE id = ?',
        [event.id],
      );
      expect(beforeReservation?.status).toBe('active');
      expect(beforeEvent?.remaining_seats).toBe(4);

      // Inject a fault on the seat-increment UPDATE (the second write inside the
      // cancel transaction). All other writes go through to the real database.
      const realRun = ctx.db.run.bind(ctx.db);
      const runSpy = jest
        .spyOn(ctx.db, 'run')
        .mockImplementation((sql: string, params?: unknown[]) => {
          if (
            typeof sql === 'string' &&
            /UPDATE\s+events/i.test(sql) &&
            /remaining_seats/i.test(sql)
          ) {
            throw new Error('injected fault on seat increment');
          }
          return realRun(sql, params);
        });

      try {
        // The cancellation fails; the error surfaces (mapped to HTTP 500 in the
        // HTTP path) instead of leaving a half-applied state.
        expect(() => ctx.reservations.cancel(buyer, reservationId)).toThrow(
          'injected fault on seat increment',
        );
      } finally {
        runSpy.mockRestore();
      }

      // Transaction rolled back: the reservation is still active and the event's
      // remaining seats are unchanged — no partial commit (Req 12.2).
      const afterReservation = ctx.db.get<{ status: string }>(
        'SELECT status FROM reservations WHERE id = ?',
        [reservationId],
      );
      const afterEvent = ctx.db.get<{ remaining_seats: number }>(
        'SELECT remaining_seats FROM events WHERE id = ?',
        [event.id],
      );
      expect(afterReservation?.status).toBe('active');
      expect(afterEvent?.remaining_seats).toBe(4);
    });
  });
});

// -----------------------------------------------------------------------------
// 2. Missing/empty signing secret -> service-unavailable branch (Req 2.5, 2.6)
// -----------------------------------------------------------------------------
// Unit-tested in isolation: AuthService is constructed with a ConfigService stub
// that returns no JWT secret, so the 503 branch is exercised without depending
// on the running app (which fails fast at startup when the secret is missing).
describe('Req 2.5/2.6 — login is service-unavailable (503) when the signing secret is missing/empty', () => {
  const buildService = (
    secretValue: string | undefined,
  ): {
    service: AuthService;
    findByLogin: jest.Mock;
    sign: jest.Mock;
  } => {
    const findByLogin = jest.fn();
    const sign = jest.fn();
    const usersStub = { findByLogin } as unknown as UsersService;
    const jwtStub = { sign } as unknown as JwtService;
    const configStub = {
      get: jest.fn().mockReturnValue(secretValue),
    } as unknown as ConfigService;
    return {
      service: new AuthService(usersStub, jwtStub, configStub),
      findByLogin,
      sign,
    };
  };

  it('throws ServiceUnavailableException (503) when JWT_SECRET is undefined and issues no token', () => {
    const { service, findByLogin, sign } = buildService(undefined);

    let thrown: unknown;
    try {
      service.login({ login: 'someone', password: 'whatever-123' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getStatus()).toBe(503);
    // No credential lookup and no signing happened — no token was issued.
    expect(findByLogin).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableException (503) when JWT_SECRET is an empty string', () => {
    const { service, sign } = buildService('');

    expect(() =>
      service.login({ login: 'someone', password: 'whatever-123' }),
    ).toThrow(ServiceUnavailableException);
    expect(sign).not.toHaveBeenCalled();
  });
});
