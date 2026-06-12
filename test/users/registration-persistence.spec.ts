// Feature: event-ticket-reservation, Property 1: Registration persists a retrievable BUYER with verbatim password
//
// Property 1: For any valid login (1–254 chars) and password (8–128 chars),
// registering creates exactly one new active user retrievable by the returned
// id, whose stored password byte-for-byte equals the submitted password and
// whose role equals BUYER (0).
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.6

import fc from 'fast-check';

import { Role } from '../../src/common/types';
import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Snake_case mirror of the persisted users row, as read straight from SQLite. */
interface PersistedUserRow {
  id: string;
  login: string;
  password: string;
  role: number;
  status: string;
}

describe('Property 1: Registration persists a retrievable BUYER with verbatim password', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('persists exactly one active BUYER per registration, retrievable by id with a verbatim password', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        async (login, password) => {
          // Count users before registering so we can assert exactly one new row.
          const before = ctx.db.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users',
          );
          const countBefore = before?.count ?? 0;

          const { id } = ctx.users.register({ login, password });

          // Exactly one additional user row exists after registration (Req 1.1).
          const after = ctx.db.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users',
          );
          expect(after?.count).toBe(countBefore + 1);

          // The new user is retrievable by the returned id (Req 1.1, 1.6).
          const rows = ctx.db.all<PersistedUserRow>(
            'SELECT id, login, password, role, status FROM users WHERE id = ?',
            [id],
          );
          // Exactly one row carries the returned id.
          expect(rows).toHaveLength(1);

          const row = rows[0];
          // It is created active (Req 1.1 — a usable account).
          expect(row.status).toBe('active');
          // The stored login matches what was submitted.
          expect(row.login).toBe(login);
          // The password is stored byte-for-byte, without hashing (Req 1.2).
          expect(row.password).toBe(password);
          // The assigned role is BUYER (0) (Req 1.3).
          expect(row.role).toBe(Role.BUYER);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
