// Feature: event-ticket-reservation, Property 6: Invalid or expired tokens are rejected before the handler runs
//
// Property 6: For any token that is absent, malformed, has an invalid
// signature, or whose expiration has passed, a request to a protected route is
// rejected with HTTP 401 and the route handler is never executed.
//
// The protected route under test is `GET /reservations/me`, which is guarded by
// the controller-level JwtAuthGuard (Requirement 3). The guard rejects the four
// invalid-token shapes with HTTP 401 before the handler runs. Because the
// handler (reservation history) would otherwise return HTTP 200 with a JSON
// body, asserting an exact 401 confirms the handler never executed: a 200 (or
// any non-401 status) would mean the guard let the request through.
//
// Validates: Requirements 3.1, 3.2, 3.3

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { Role } from '../../src/common/types';
import { uniqueValidLogin, validPasswordArbitrary } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** The protected route exercised by this property. */
const PROTECTED_ROUTE = '/reservations/me';

/**
 * Discriminated description of one invalid Authorization header shape. The
 * concrete header string is materialized at request time (see
 * {@link buildAuthHeader}) because the signed-token cases need the running
 * JwtService and the configured secret.
 */
type InvalidAuthCase =
  | { kind: 'absent' }
  | { kind: 'malformed-no-scheme'; value: string }
  | { kind: 'malformed-bearer-garbage'; value: string }
  | { kind: 'bad-signature'; role: Role }
  | { kind: 'expired'; role: Role };

/** A non-empty, space-free token-ish blob that is not a valid JWT. */
const garbageToken = fc
  .string({ minLength: 1, maxLength: 48 })
  .map((s) => s.replace(/\s/g, ''))
  .filter((s) => s.length > 0);

/** Any of the three Role enum values, used to vary signed-token payloads. */
const anyRole = fc.constantFrom(Role.BUYER, Role.ORGANIZER, Role.ADMINISTRATOR);

/**
 * fast-check generator covering all four rejected token shapes from Req 3.3:
 *  - absent: no Authorization header at all (Req 3.1).
 *  - malformed-no-scheme: a raw value with no `Bearer ` scheme.
 *  - malformed-bearer-garbage: `Bearer <garbage>` that cannot be parsed.
 *  - bad-signature: a well-formed JWT signed with the WRONG secret.
 *  - expired: a well-formed JWT signed with the CORRECT secret but already past
 *    its expiration (Req 3.2).
 */
const invalidAuthCase: fc.Arbitrary<InvalidAuthCase> = fc.oneof(
  fc.constant<InvalidAuthCase>({ kind: 'absent' }),
  garbageToken.map<InvalidAuthCase>((value) => ({
    kind: 'malformed-no-scheme',
    value,
  })),
  garbageToken.map<InvalidAuthCase>((value) => ({
    kind: 'malformed-bearer-garbage',
    value,
  })),
  anyRole.map<InvalidAuthCase>((role) => ({ kind: 'bad-signature', role })),
  anyRole.map<InvalidAuthCase>((role) => ({ kind: 'expired', role })),
);

describe('Property 6: Invalid or expired tokens are rejected before the handler runs', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let configuredSecret: string;
  /** A genuinely registered user, so the only fault is the token itself. */
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);
    configuredSecret =
      ctx.getService(ConfigService).get<string>('JWT_SECRET') ?? '';
    const reg = ctx.users.register({
      login: `prop6-${Date.now()}`,
      password: 'valid-password-123',
    });
    userId = reg.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /**
   * Materialize the Authorization header value for a given case. Returns
   * `undefined` to signal the header must be omitted entirely.
   */
  const buildAuthHeader = (c: InvalidAuthCase): string | undefined => {
    switch (c.kind) {
      case 'absent':
        return undefined;
      case 'malformed-no-scheme':
        // No `Bearer ` scheme -> the guard cannot extract a token (Req 3.1).
        return c.value;
      case 'malformed-bearer-garbage':
        // Bearer scheme present but the token is not a parseable JWT (Req 3.3).
        return `Bearer ${c.value}`;
      case 'bad-signature': {
        // Valid structure, valid (future) expiry, but signed with a secret that
        // differs from the configured one, so signature verification fails.
        const token = jwtService.sign(
          { sub: userId, role: c.role },
          { secret: `${configuredSecret}-WRONG-SECRET`, expiresIn: 3600 },
        );
        return `Bearer ${token}`;
      }
      case 'expired': {
        // Correct secret, but the expiration timestamp is already in the past.
        const token = jwtService.sign(
          { sub: userId, role: c.role },
          { expiresIn: '-10s' },
        );
        return `Bearer ${token}`;
      }
    }
  };

  it('rejects absent, malformed, bad-signature, and expired tokens with HTTP 401 on a protected route', async () => {
    await fc.assert(
      fc.asyncProperty(invalidAuthCase, async (c) => {
        const header = buildAuthHeader(c);

        let pending = request(ctx.app.getHttpServer()).get(PROTECTED_ROUTE);
        if (header !== undefined) {
          pending = pending.set('Authorization', header);
        }
        const response = await pending;

        // The guard rejected the request with exactly 401: any other status
        // (e.g. 200 from the history handler) would mean the handler ran.
        expect(response.status).toBe(401);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Sanity check: a correctly signed, unexpired token for a registered user is
  // accepted, proving the 401s above come from the invalid tokens and not from
  // the route being unreachable.
  it('accepts a valid token on the same protected route (sanity check)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        async (login, password) => {
          const { id } = ctx.users.register({ login, password });
          const token = jwtService.sign({ sub: id, role: Role.BUYER });

          const response = await request(ctx.app.getHttpServer())
            .get(PROTECTED_ROUTE)
            .set('Authorization', `Bearer ${token}`);

          // The guard let the request through to the handler: not a 401.
          expect(response.status).not.toBe(401);
          expect(response.status).toBe(200);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
