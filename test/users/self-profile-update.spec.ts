// Feature: event-ticket-reservation, Property 13: Self-profile updates persist non-role fields and ignore role
//
// Property 13: For any authenticated user and any valid personal-data payload
// (which may include a role field), updating the user's own profile persists
// every personal-data field while leaving the stored role unchanged, and the
// updated values are retrievable.
//
// This is exercised at the HTTP level via PATCH /users/me so the global
// whitelisting Validation_Pipe is in the loop: a request body that INCLUDES a
// bogus `role` field plus a valid login/password must have its `role` stripped
// before the handler runs (Requirement 6.2), while the personal-data fields are
// persisted and retrievable (Requirement 6.1). To make "role unchanged"
// meaningful across every role, the user is optionally promoted to a generated
// role by the seeded administrator before the update.
//
// Validates: Requirements 6.1, 6.2

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

/**
 * A "role" value to inject into the update payload. Includes the in-enum values
 * plus an out-of-enum number, all of which the whitelisting Validation_Pipe
 * must strip so none ever reaches persistence (Requirement 6.2).
 */
const bogusRoleArbitrary: fc.Arbitrary<number> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
  99,
);

/** Snake_case mirror of the persisted users row, as read straight from SQLite. */
interface PersistedUserRow {
  id: string;
  login: string;
  password: string;
  role: number;
}

describe('Property 13: Self-profile updates persist non-role fields and ignore role', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

    // The startup seed creates exactly one administrator; use it as the actor
    // that promotes generated users to non-BUYER roles so the "role unchanged"
    // assertion is meaningful across every role.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminActor = { id: admin.id, role: Role.ADMINISTRATOR };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('persists submitted login/password and ignores a role field, leaving the stored role unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        roleArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        bogusRoleArbitrary,
        async (
          login,
          password,
          desiredRole,
          newLogin,
          newPassword,
          bogusRole,
        ) => {
          // Register the user; the registered role is always BUYER (0).
          const { id } = ctx.users.register({ login, password });

          // Optionally promote the user so the property covers every role.
          if (desiredRole !== Role.BUYER) {
            ctx.users.changeRole(adminActor, id, desiredRole);
          }

          // Capture the role as stored immediately before the update.
          const before = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [id],
          );
          const originalRole = before?.role;

          // Mint a token for the user so the protected route is reachable.
          const token = jwtService.sign({ sub: id, role: desiredRole });

          // PATCH /users/me with valid personal data PLUS a bogus role field.
          // The whitelisting Validation_Pipe must strip `role` (Req 6.2).
          const response = await request(ctx.app.getHttpServer())
            .patch('/users/me')
            .set('Authorization', `Bearer ${token}`)
            .send({ login: newLogin, password: newPassword, role: bogusRole });

          // The update succeeded (Req 6.1).
          expect(response.status).toBe(200);

          // The persisted personal-data fields equal the submitted values and
          // are retrievable; the stored role is unchanged (Req 6.1, 6.2).
          const after = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [id],
          );
          expect(after).toBeDefined();
          expect(after?.login).toBe(newLogin);
          expect(after?.password).toBe(newPassword);
          expect(after?.role).toBe(originalRole);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
