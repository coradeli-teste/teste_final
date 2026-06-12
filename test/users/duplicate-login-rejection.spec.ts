// Feature: event-ticket-reservation, Property 2: Duplicate active login is rejected without side effects
//
// Property 2: For any login already held by an active user, a second
// registration with that login is rejected with HTTP 409 (ConflictException)
// and the total user count is unchanged (no new row is persisted).
//
// Validates: Requirements 1.4

import { ConflictException, HttpException } from '@nestjs/common';
import fc from 'fast-check';

import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

describe('Property 2: Duplicate active login is rejected without side effects', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects a second registration for an active login with HTTP 409 and persists no new row', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        validPasswordArbitrary,
        async (login, firstPassword, secondPassword) => {
          // First registration with a unique login succeeds and creates a row.
          const { id } = ctx.users.register({ login, password: firstPassword });
          expect(typeof id).toBe('string');

          // Capture the total user count once the active login exists.
          const before = ctx.db.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users',
          );
          const countBefore = before?.count ?? 0;

          // A second registration with the SAME login (any valid password) must
          // be rejected with HTTP 409 Conflict (Requirement 1.4).
          let thrown: unknown;
          try {
            ctx.users.register({ login, password: secondPassword });
          } catch (error) {
            thrown = error;
          }

          // Assert the exact exception type and HTTP status code.
          expect(thrown).toBeInstanceOf(ConflictException);
          expect((thrown as HttpException).getStatus()).toBe(409);

          // No side effects: the users table count is unchanged (no new row).
          const after = ctx.db.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users',
          );
          expect(after?.count).toBe(countBefore);

          // The single active row for this login still holds the first password
          // (the rejected attempt did not overwrite anything).
          const rows = ctx.db.all<{ id: string; password: string }>(
            `SELECT id, password FROM users WHERE login = ? AND status = 'active'`,
            [login],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].id).toBe(id);
          expect(rows[0].password).toBe(firstPassword);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
