// Feature: event-ticket-reservation, Property 14: Invalid or cross-user profile updates leave data unchanged
//
// Property 14: For any invalid personal-data payload (HTTP 400), and for any
// update targeting a different user's data (HTTP 403), the request is rejected
// and the stored data of the target is unchanged.
//
// Two complementary cases are exercised:
//
//   * Invalid payload (Requirement 6.3 -> 400): PATCH /users/me is called with
//     a valid user token but a body that fails DTO validation (password shorter
//     than 8, login longer than 254, or a wrong-typed field). The whitelisting
//     Validation_Pipe must reject the request with HTTP 400 before the handler
//     runs, leaving the user's stored login/password unchanged.
//
//   * Cross-user (Requirement 6.4 -> 403): the PATCH /users/me route only ever
//     updates the authenticated user (updateOwnProfile(actor, actor.id, dto)),
//     so there is no HTTP path to target another user. The service is exercised
//     directly: updateOwnProfile(actorA, userB.id, validDto) must throw a
//     ForbiddenException (HTTP 403) when the target id differs from the actor,
//     and user B's stored row must be unchanged.
//
// Validates: Requirements 6.3, 6.4

import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { AuthUser, Role } from '../../src/common/types';
import {
  asciiStringOfLength,
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
}

/**
 * A personal-data payload that must fail DTO validation. Each variant carries
 * at least one invalid field so the whitelisting Validation_Pipe rejects the
 * whole request with HTTP 400 (Requirement 6.3):
 *   - login longer than the 254-character maximum;
 *   - password shorter than the 8-character minimum;
 *   - login/password of the wrong type (number / boolean), violating @IsString.
 */
const invalidUpdatePayload: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  asciiStringOfLength(255, 300).map((login) => ({ login })),
  asciiStringOfLength(1, 7).map((password) => ({ password })),
  asciiStringOfLength(0, 7).map((password) => ({ password })),
  fc.integer().map((login) => ({ login })),
  fc.integer().map((password) => ({ password })),
  fc.boolean().map((login) => ({ login })),
);

describe('Property 14: Invalid or cross-user profile updates leave data unchanged', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects an invalid PATCH /users/me payload with HTTP 400 and leaves the stored data unchanged (Req 6.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        invalidUpdatePayload,
        async (login, password, badPayload) => {
          // Register a user and capture its stored credentials.
          const { id } = ctx.users.register({ login, password });

          const before = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [id],
          );

          // Mint a valid token so the request reaches the Validation_Pipe.
          const token = jwtService.sign({ sub: id, role: Role.BUYER });

          const response = await request(ctx.app.getHttpServer())
            .patch('/users/me')
            .set('Authorization', `Bearer ${token}`)
            .send(badPayload);

          // The invalid payload is rejected before the handler runs (Req 6.3).
          expect(response.status).toBe(400);

          // The stored personal data is unchanged.
          const after = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [id],
          );
          expect(after?.login).toBe(before?.login);
          expect(after?.password).toBe(before?.password);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a cross-user update with ForbiddenException (HTTP 403) and leaves the target's stored data unchanged (Req 6.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        async (
          loginA,
          passwordA,
          loginB,
          passwordB,
          newLogin,
          newPassword,
        ) => {
          // Register two distinct users; A is the actor, B is the target.
          const { id: userAId } = ctx.users.register({
            login: loginA,
            password: passwordA,
          });
          const { id: userBId } = ctx.users.register({
            login: loginB,
            password: passwordB,
          });

          const actorA: AuthUser = { id: userAId, role: Role.BUYER };

          const before = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [userBId],
          );

          // Actor A attempts to update user B's profile with a valid payload.
          expect(() =>
            ctx.users.updateOwnProfile(actorA, userBId, {
              login: newLogin,
              password: newPassword,
            }),
          ).toThrow(ForbiddenException);

          // User B's stored data is unchanged (Req 6.4).
          const after = ctx.db.get<PersistedUserRow>(
            'SELECT id, login, password, role FROM users WHERE id = ?',
            [userBId],
          );
          expect(after?.login).toBe(before?.login);
          expect(after?.password).toBe(before?.password);
          expect(after?.role).toBe(before?.role);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
