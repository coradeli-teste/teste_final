// Feature: event-ticket-reservation, Property 3: Out-of-bounds registration input is rejected without side effects
//
// Property 3: For any registration payload whose login or password is empty,
// shorter than, or longer than the allowed bounds (login 1–254 chars, password
// 8–128 chars), or that omits a required field, the HTTP endpoint
// POST /auth/register rejects the request with HTTP 400 and creates no user
// record.
//
// Validation happens at the HTTP layer (the global ValidationPipe against
// RegisterUserDto), NOT inside UsersService.register, so this property is
// exercised through the real endpoint with supertest.
//
// Validates: Requirements 1.5

import fc from 'fast-check';
import request from 'supertest';

import { asciiStringOfLength } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Shape of a (possibly partial / invalid) registration payload. */
type RegistrationPayload = {
  login?: unknown;
  password?: unknown;
};

/** A login that satisfies the 1–254 character bound. */
const validLogin = asciiStringOfLength(1, 254);
/** A password that satisfies the 8–128 character bound. */
const validPassword = asciiStringOfLength(8, 128);

/**
 * A representative mix of invalid registration payloads spanning every
 * out-of-bounds / missing-field category called out in Requirement 1.5.
 */
const invalidPayloadArbitrary: fc.Arbitrary<RegistrationPayload> = fc.oneof(
  // Empty login (length 0) with an otherwise valid password.
  validPassword.map((password) => ({ login: '', password })),
  // Login longer than the 254-character maximum.
  fc
    .tuple(asciiStringOfLength(255, 320), validPassword)
    .map(([login, password]) => ({ login, password })),
  // Password shorter than the 8-character minimum (includes the empty string).
  fc
    .tuple(validLogin, asciiStringOfLength(0, 7))
    .map(([login, password]) => ({ login, password })),
  // Password longer than the 128-character maximum.
  fc
    .tuple(validLogin, asciiStringOfLength(129, 200))
    .map(([login, password]) => ({ login, password })),
  // Missing login field entirely.
  validPassword.map((password) => ({ password })),
  // Missing password field entirely.
  validLogin.map((login) => ({ login })),
);

describe('Property 3: Out-of-bounds registration input is rejected without side effects', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects every out-of-bounds or incomplete registration payload with HTTP 400 and persists no user', async () => {
    await fc.assert(
      fc.asyncProperty(invalidPayloadArbitrary, async (payload) => {
        // Snapshot the user count before the attempt so we can prove the
        // rejected request created no row (Req 1.5 — "create no user record").
        const before = ctx.db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users',
        );
        const countBefore = before?.count ?? 0;

        // Exercise the real HTTP endpoint so the global ValidationPipe runs.
        const response = await request(ctx.app.getHttpServer())
          .post('/auth/register')
          .send(payload as object);

        // The payload is rejected with HTTP 400 (Req 1.5).
        expect(response.status).toBe(400);

        // No user row was created as a side effect of the rejected request.
        const after = ctx.db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users',
        );
        expect(after?.count).toBe(countBefore);

        // When a login string was supplied, no record exists for it either.
        if (typeof payload.login === 'string') {
          const match = ctx.db.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users WHERE login = ?',
            [payload.login],
          );
          expect(match?.count ?? 0).toBe(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
