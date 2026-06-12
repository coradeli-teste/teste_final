// Feature: event-ticket-reservation, Property 4: Issued tokens carry correct identity and fixed lifetime
//
// Property 4: For any user who logs in with credentials matching a stored
// record, the issued JWT verifies against the configured secret, its payload
// `sub` equals the user id and `role` equals the user's role, and `exp - iat`
// equals exactly 3600 seconds.
//
// Validates: Requirements 2.1, 2.2, 2.7

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Fixed JWT lifetime in seconds (Requirement 2.2, 2.7). */
const EXPECTED_TTL_SECONDS = 3600;

/** Verified JWT payload shape carrying identity, role, and standard claims. */
interface VerifiedTokenPayload {
  sub: string;
  role: number;
  iat: number;
  exp: number;
}

/**
 * The set of roles an authenticated user may hold. Freshly registered users are
 * BUYER; the others are reached by an administrator promotion so the property
 * is exercised across every role.
 */
const roleArbitrary: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
);

describe('Property 4: Issued tokens carry correct identity and fixed lifetime', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let secret: string;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);
    secret = ctx.getService(ConfigService).get<string>('JWT_SECRET')!;

    // The startup seed creates exactly one administrator; use it as the actor
    // that promotes generated users to non-BUYER roles.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminActor = { id: admin.id, role: Role.ADMINISTRATOR };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('issues a verifiable token whose sub/role match the user and whose lifetime is exactly 3600s', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        roleArbitrary,
        async (login, password, desiredRole) => {
          // Register the user; the registered role is always BUYER (0).
          const { id } = ctx.users.register({ login, password });

          // Optionally promote the user so the property covers every role.
          if (desiredRole !== Role.BUYER) {
            ctx.users.changeRole(adminActor, id, desiredRole);
          }

          // Log in with the matching credentials to obtain a session token.
          const { accessToken } = ctx.auth.login({ login, password });

          // The token verifies against the configured secret (Req 2.1, 2.7);
          // a wrong/missing secret would throw here.
          const payload = jwtService.verify<VerifiedTokenPayload>(
            accessToken,
            { secret },
          );

          // Payload identity matches the stored user (Req 2.7).
          expect(payload.sub).toBe(id);
          // Payload role matches the user's current role (Req 2.7).
          expect(payload.role).toBe(desiredRole);

          // Standard lifetime claims are present and the lifetime is fixed at
          // exactly 3600 seconds (Req 2.2, 2.7).
          expect(typeof payload.iat).toBe('number');
          expect(typeof payload.exp).toBe('number');
          expect(payload.exp - payload.iat).toBe(EXPECTED_TTL_SECONDS);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
