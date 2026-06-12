// Feature: event-ticket-reservation, Property 5: Invalid credentials never yield a token
//
// Property 5: For any login/password pair that does not match a stored user
// record (wrong password, unknown login, or empty/missing field), login is
// rejected (HTTP 401 for mismatch; field-identifying error for empty/missing)
// and no token is issued.
//
// Validates: Requirements 2.3, 2.4

import { UnauthorizedException } from '@nestjs/common';
import fc from 'fast-check';
import request from 'supertest';

import {
  uniqueValidLogin,
  validPasswordArbitrary,
} from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

describe('Property 5: Invalid credentials never yield a token', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // Req 2.3: a registered login with the WRONG password is rejected with 401
  // (UnauthorizedException) and no token is returned.
  it('rejects a registered login with a wrong password and issues no token', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        validPasswordArbitrary,
        async (login, password, otherPassword) => {
          // Register a real user with a known password.
          ctx.users.register({ login, password });

          // Build a wrong password that is guaranteed to differ from the real
          // one (append a char and regenerate-by-mutation if they collide).
          let wrongPassword = otherPassword;
          if (wrongPassword === password) {
            wrongPassword = `${password}x`;
          }
          expect(wrongPassword).not.toBe(password);

          // The service rejects the mismatch with 401 and returns no token.
          let token: unknown;
          expect(() => {
            token = ctx.auth.login({ login, password: wrongPassword });
          }).toThrow(UnauthorizedException);
          expect(token).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Req 2.3: an unknown login (never registered) is rejected with 401 and no
  // token is returned.
  it('rejects an unknown login and issues no token', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        async (login, password) => {
          // This login is globally unique and never registered, so it cannot
          // match any stored record.
          let token: unknown;
          expect(() => {
            token = ctx.auth.login({ login, password });
          }).toThrow(UnauthorizedException);
          expect(token).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Req 2.4: empty or missing fields are rejected at the HTTP layer by the
  // ValidationPipe with HTTP 400, and no token is issued. The body shape is
  // chosen so exactly one field is empty or missing on each generated case.
  it('rejects empty or missing login/password at the HTTP layer with 400 and no token', async () => {
    type LoginBody = { login?: string; password?: string };

    // Each case maps a non-empty filler value to a malformed login body.
    const bodyArbitrary: fc.Arbitrary<LoginBody> = validPasswordArbitrary.chain(
      (filler) =>
        fc.constantFrom<LoginBody>(
          { login: '', password: filler }, // empty login
          { login: filler, password: '' }, // empty password
          { password: filler }, // missing login
          { login: filler }, // missing password
        ),
    );

    await fc.assert(
      fc.asyncProperty(bodyArbitrary, async (body) => {
        const response = await request(ctx.app.getHttpServer())
          .post('/auth/login')
          .send(body);

        // The ValidationPipe rejects the payload before the handler (Req 2.4).
        expect(response.status).toBe(400);
        // No token is present anywhere in the response envelope.
        const serialized = JSON.stringify(response.body ?? {});
        expect(serialized).not.toContain('accessToken');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
