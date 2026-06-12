// Feature: event-ticket-reservation, Property 9: Unauthorized or self role changes are rejected without effect
//
// Property 9: For any actor whose role is not ADMINISTRATOR attempting to
// change any user's role, and for any actor attempting to change their own
// role, the request is rejected with HTTP 403 (ForbiddenException) and the
// target role is unchanged.
//
// Validates: Requirements 5.2, 5.3

import { ForbiddenException, HttpException } from '@nestjs/common';
import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Roles an actor can hold without being an administrator (Requirement 5.2). */
const nonAdminRoleArbitrary: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
);

/** Any role within the enumeration, including ADMINISTRATOR. */
const anyRoleArbitrary: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
);

describe('Property 9: Unauthorized or self role changes are rejected without effect', () => {
  let ctx: TestAppContext;
  /** The seeded administrator, used to promote actors when constructing cases. */
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Expected the seeded administrator to exist');
    }
    adminActor = { id: admin.id, role: admin.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects a non-administrator actor changing another user role with 403 and leaves the target unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        nonAdminRoleArbitrary,
        anyRoleArbitrary,
        async (
          actorLogin,
          actorPassword,
          targetLogin,
          targetPassword,
          actorRole,
          requestedRole,
        ) => {
          // Register the actor; promote to its (non-admin) role via the admin.
          const { id: actorId } = ctx.users.register({
            login: actorLogin,
            password: actorPassword,
          });
          if (actorRole !== Role.BUYER) {
            ctx.users.changeRole(adminActor, actorId, actorRole);
          }
          const nonAdminActor: AuthUser = { id: actorId, role: actorRole };

          // Register a separate target user and capture its stored role.
          const { id: targetId } = ctx.users.register({
            login: targetLogin,
            password: targetPassword,
          });
          const before = ctx.db.get<{ role: number }>(
            'SELECT role FROM users WHERE id = ?',
            [targetId],
          );
          const roleBefore = before?.role;

          // The non-admin actor's attempt must be rejected with HTTP 403.
          let thrown: unknown;
          try {
            ctx.users.changeRole(nonAdminActor, targetId, requestedRole);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(ForbiddenException);
          expect((thrown as HttpException).getStatus()).toBe(403);

          // The target user's stored role is unchanged (Requirement 5.2).
          const after = ctx.db.get<{ role: number }>(
            'SELECT role FROM users WHERE id = ?',
            [targetId],
          );
          expect(after?.role).toBe(roleBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects any actor changing their own role with 403 and leaves the role unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        anyRoleArbitrary,
        anyRoleArbitrary,
        async (actorLogin, actorPassword, actorRole, requestedRole) => {
          // Register the actor; promote to its role (incl. ADMINISTRATOR) via admin.
          const { id: actorId } = ctx.users.register({
            login: actorLogin,
            password: actorPassword,
          });
          if (actorRole !== Role.BUYER) {
            ctx.users.changeRole(adminActor, actorId, actorRole);
          }
          const actor: AuthUser = { id: actorId, role: actorRole };

          const before = ctx.db.get<{ role: number }>(
            'SELECT role FROM users WHERE id = ?',
            [actorId],
          );
          const roleBefore = before?.role;

          // A self-targeted role change is forbidden even for administrators.
          let thrown: unknown;
          try {
            ctx.users.changeRole(actor, actor.id, requestedRole);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(ForbiddenException);
          expect((thrown as HttpException).getStatus()).toBe(403);

          // The actor's stored role is unchanged (Requirement 5.3).
          const after = ctx.db.get<{ role: number }>(
            'SELECT role FROM users WHERE id = ?',
            [actorId],
          );
          expect(after?.role).toBe(roleBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
