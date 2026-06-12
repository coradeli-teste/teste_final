// Feature: event-ticket-reservation, Property 8: Administrators set valid roles on other users
//
// Property 8: For any administrator actor, any existing target user other than
// the actor, and any role value within the enum {BUYER, ORGANIZER,
// ADMINISTRATOR}, the role change persists so the target's stored role equals
// the requested value.
//
// Validates: Requirements 5.1

import fc from 'fast-check';

import { AuthUser, Role } from '../../src/common/types';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Any in-enum role value the administrator may assign to a target user. */
const roleArbitrary: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
);

describe('Property 8: Administrators set valid roles on other users', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup (login/password "administrator",
    // role ADMINISTRATOR). Resolve it as the acting administrator.
    const seeded = ctx.users.findByLogin('administrator');
    expect(seeded).toBeDefined();
    expect(seeded?.role).toBe(Role.ADMINISTRATOR);
    adminActor = { id: seeded!.id, role: seeded!.role };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('persists the requested in-enum role on a target user other than the actor', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        roleArbitrary,
        async (login, password, role) => {
          // A fresh target user (created as BUYER) distinct from the admin actor.
          const { id: targetId } = ctx.users.register({ login, password });
          expect(targetId).not.toBe(adminActor.id);

          // The administrator changes the target's role to the requested value.
          ctx.users.changeRole(adminActor, targetId, role);

          // The change persists: the target's stored role equals the request.
          const row = ctx.db.get<{ role: number }>(
            'SELECT role FROM users WHERE id = ?',
            [targetId],
          );
          expect(row?.role).toBe(role);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
