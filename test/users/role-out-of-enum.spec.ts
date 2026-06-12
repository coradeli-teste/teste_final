// Feature: event-ticket-reservation, Property 10: Out-of-enum role values are rejected without effect
//
// Property 10: For any role-change request whose role value is not within the
// enum {0, 1, 2} (out of range or non-integer), the request is rejected with
// HTTP 400 and the target role is unchanged.
//
// The enum validation lives in ChangeRoleDto (`@IsInt` + `@IsEnum(Role)`),
// enforced by the global ValidationPipe at the HTTP layer. We therefore exercise
// the real route `PATCH /users/:id/role` via supertest:
//   - A genuine target user is registered (defaults to BUYER = 0).
//   - The request is authenticated as the seeded administrator with a valid JWT,
//     so a 400 can only come from DTO validation (not 401/403).
//   - For each out-of-enum role value the response must be exactly HTTP 400 and
//     the target's stored role (read directly from SQLite) must be unchanged.
//
// Validates: Requirements 5.4

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/**
 * Generator of role values that are NOT within the Role enum {0, 1, 2}:
 *  - integers below 0 or at/above 3 (out of range),
 *  - non-integer numbers (e.g. 1.5),
 *  - strings (no string is a valid integer Role),
 *  - null.
 */
const outOfRangeInteger = fc.oneof(
  fc.integer({ min: 3, max: 1_000_000 }),
  fc.integer({ min: -1_000_000, max: -1 }),
);

const nonInteger = fc
  .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
  .filter((x) => !Number.isInteger(x));

const stringRole = fc.string();

const nullRole = fc.constant(null);

const outOfEnumRole: fc.Arbitrary<number | string | null> = fc.oneof(
  outOfRangeInteger,
  nonInteger,
  stringRole,
  nullRole,
);

describe('Property 10: Out-of-enum role values are rejected without effect', () => {
  let ctx: TestAppContext;
  /** Valid administrator bearer token, so the only fault is the role value. */
  let adminToken: string;
  /** A genuine target user whose role must remain unchanged. */
  let targetId: string;
  /** The target's stored role at registration time (BUYER = 0). */
  let initialRole: number;

  beforeAll(async () => {
    ctx = await createTestApp();

    // Authenticate as the seeded administrator: resolve its id and sign a JWT
    // with the correct configured secret via the running JwtService.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Seeded administrator was not found');
    }
    const jwtService = ctx.getService(JwtService);
    adminToken = jwtService.sign({ sub: admin.id, role: Role.ADMINISTRATOR });

    // Register a fresh target user (defaults to BUYER = 0).
    const reg = ctx.users.register({
      login: `prop10-target-${Date.now()}`,
      password: 'valid-password-123',
    });
    targetId = reg.id;

    const row = ctx.db.get<{ role: number }>(
      'SELECT role FROM users WHERE id = ?',
      [targetId],
    );
    initialRole = row!.role;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rejects out-of-enum role values with HTTP 400 and leaves the target role unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(outOfEnumRole, async (invalidRole) => {
        const response = await request(ctx.app.getHttpServer())
          .patch(`/users/${targetId}/role`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ role: invalidRole });

        // DTO validation rejects the out-of-enum value before persistence.
        expect(response.status).toBe(400);

        // The target's stored role is unchanged (no side effect).
        const row = ctx.db.get<{ role: number }>(
          'SELECT role FROM users WHERE id = ?',
          [targetId],
        );
        expect(row!.role).toBe(initialRole);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Sanity check: a valid in-enum role with the same admin token succeeds,
  // proving the 400s above come from the invalid role value and not from the
  // route being unreachable or the token being rejected.
  it('accepts a valid in-enum role with the same admin token (sanity check)', async () => {
    const reg = ctx.users.register({
      login: `prop10-sanity-${Date.now()}`,
      password: 'valid-password-123',
    });

    const response = await request(ctx.app.getHttpServer())
      .patch(`/users/${reg.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.ORGANIZER });

    expect(response.status).toBe(200);

    const row = ctx.db.get<{ role: number }>(
      'SELECT role FROM users WHERE id = ?',
      [reg.id],
    );
    expect(row!.role).toBe(Role.ORGANIZER);
  });
});
