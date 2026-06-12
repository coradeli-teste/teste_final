// Feature: event-ticket-reservation, Property 32: Invalid payloads are rejected per-field before the handler
//
// Property 32: For any request payload that fails validation against its DTO
// rules, the global ValidationPipe rejects the request with HTTP 400 carrying
// an error indication per failed field, and the route handler is NOT executed.
//
// Validates: Requirements 14.4
//
// Strategy (HTTP-level via supertest):
//   - POST /auth/register (public, RegisterUserDto: login 1-254, password 8-128)
//   - POST /events       (ORGANIZER/ADMIN only, CreateEventDto: title non-empty
//                         string, startDate future ISO-8601, totalSeats int 1..1_000_000)
//
// For each DTO we independently make each field either VALID or one of several
// INVALID variants (empty/oversized/too-short/too-long/missing/wrong-type),
// guaranteeing at least one invalid field per generated payload, and we record
// which fields were made invalid. We then assert:
//   1. HTTP 400.
//   2. The failure envelope produced by AllExceptionsFilter preserves the
//      ValidationPipe per-field message array at `body.error.message`, and that
//      array names EVERY field we corrupted (per-field reporting, Req 14.4).
//   3. The handler never ran: the total row count for the target table is
//      unchanged across the whole property run (no user / no event persisted).
//
// POST /events is exercised with a valid ADMINISTRATOR token (minted via
// JwtService) so the guard chain passes and the 400 is attributable to body
// validation, not to authentication/authorization. POST /auth/register is
// public, so it reaches the pipe with no token.

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { Role } from '../../src/common/types';
import { asciiStringOfLength } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 150;

/** Extract the per-field validation message array from the failure envelope. */
function messageArray(body: unknown): string[] {
  const error = (body as { error?: { message?: unknown } })?.error;
  const message = error?.message;
  return Array.isArray(message) ? (message as string[]) : [];
}

/** True when some entry in the message array mentions the given field name. */
function mentionsField(messages: string[], field: string): boolean {
  const needle = field.toLowerCase();
  return messages.some((m) => m.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// RegisterUserDto generators (login 1-254, password 8-128).
// Each field arbitrary yields { value, invalid }: when `invalid` is false the
// value is within bounds; otherwise it violates @IsString / @Length.
// ---------------------------------------------------------------------------

interface Field {
  value: unknown;
  invalid: boolean;
}

const validLoginField: fc.Arbitrary<Field> = asciiStringOfLength(1, 254).map(
  (value) => ({ value, invalid: false }),
);

const invalidLoginField: fc.Arbitrary<Field> = fc.oneof(
  // empty string (length 0 < 1)
  fc.constant({ value: '', invalid: true }),
  // oversized (length > 254)
  asciiStringOfLength(255, 300).map((value) => ({ value, invalid: true })),
  // missing field (undefined)
  fc.constant({ value: undefined, invalid: true }),
  // wrong type (not a string)
  fc
    .oneof(fc.integer(), fc.boolean(), fc.constant<unknown>(null))
    .map((value) => ({ value, invalid: true })),
);

const validPasswordField: fc.Arbitrary<Field> = asciiStringOfLength(8, 128).map(
  (value) => ({ value, invalid: false }),
);

const invalidPasswordField: fc.Arbitrary<Field> = fc.oneof(
  // too short (length < 8)
  asciiStringOfLength(0, 7).map((value) => ({ value, invalid: true })),
  // too long (length > 128)
  asciiStringOfLength(129, 160).map((value) => ({ value, invalid: true })),
  // missing field (undefined)
  fc.constant({ value: undefined, invalid: true }),
  // wrong type (not a string)
  fc
    .oneof(fc.integer(), fc.boolean(), fc.constant<unknown>(null))
    .map((value) => ({ value, invalid: true })),
);

interface RegisterCase {
  payload: Record<string, unknown>;
  invalidFields: string[];
}

/** Build a register payload with >=1 invalid field, tracking which ones. */
const invalidRegisterPayload: fc.Arbitrary<RegisterCase> = fc
  .record({
    login: fc.oneof(validLoginField, invalidLoginField),
    password: fc.oneof(validPasswordField, invalidPasswordField),
  })
  .filter((r) => r.login.invalid || r.password.invalid)
  .map(({ login, password }) => {
    const payload: Record<string, unknown> = {};
    // Only attach a key when the value is defined; an undefined value models a
    // missing field (which the pipe still rejects via the validators).
    if (login.value !== undefined) payload.login = login.value;
    if (password.value !== undefined) payload.password = password.value;
    const invalidFields: string[] = [];
    if (login.invalid) invalidFields.push('login');
    if (password.invalid) invalidFields.push('password');
    return { payload, invalidFields };
  });

// ---------------------------------------------------------------------------
// CreateEventDto generators (title non-empty string, startDate future ISO-8601,
// totalSeats int 1..1_000_000).
// ---------------------------------------------------------------------------

const validTitleField: fc.Arbitrary<Field> = asciiStringOfLength(1, 80)
  // class-validator's @IsNotEmpty treats a whitespace-only string as non-empty,
  // but to keep "valid" unambiguous we require a non-space character.
  .filter((s) => s.trim().length > 0)
  .map((value) => ({ value, invalid: false }));

const invalidTitleField: fc.Arbitrary<Field> = fc.oneof(
  fc.constant({ value: '', invalid: true }), // empty -> @IsNotEmpty fails
  fc.constant({ value: undefined, invalid: true }), // missing
  fc.oneof(fc.integer(), fc.boolean()).map((value) => ({ value, invalid: true })), // wrong type
);

/** A future ISO-8601 instant (well clear of "now"). */
const validStartDateField: fc.Arbitrary<Field> = fc
  .integer({ min: 1, max: 3650 })
  .map((daysAhead) => {
    const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    return { value: d.toISOString(), invalid: false };
  });

const invalidStartDateField: fc.Arbitrary<Field> = fc.oneof(
  // not an ISO-8601 string
  asciiStringOfLength(1, 20)
    .filter((s) => Number.isNaN(Date.parse(s)))
    .map((value) => ({ value, invalid: true })),
  // missing
  fc.constant({ value: undefined, invalid: true }),
  // wrong type
  fc.oneof(fc.integer(), fc.boolean()).map((value) => ({ value, invalid: true })),
);

const validTotalSeatsField: fc.Arbitrary<Field> = fc
  .integer({ min: 1, max: 1_000_000 })
  .map((value) => ({ value, invalid: false }));

const invalidTotalSeatsField: fc.Arbitrary<Field> = fc.oneof(
  fc.integer({ min: -1000, max: 0 }).map((value) => ({ value, invalid: true })), // < 1
  fc
    .integer({ min: 1_000_001, max: 2_000_000 })
    .map((value) => ({ value, invalid: true })), // > 1_000_000
  fc
    .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 1, max: 9 }))
    .map(([whole, frac]) => ({ value: whole + frac / 10, invalid: true })), // non-integer
  fc.constant({ value: undefined, invalid: true }), // missing
  fc.constant({ value: 'lots', invalid: true }), // wrong type
);

interface EventCase {
  payload: Record<string, unknown>;
  invalidFields: string[];
}

const invalidEventPayload: fc.Arbitrary<EventCase> = fc
  .record({
    title: fc.oneof(validTitleField, invalidTitleField),
    startDate: fc.oneof(validStartDateField, invalidStartDateField),
    totalSeats: fc.oneof(validTotalSeatsField, invalidTotalSeatsField),
  })
  .filter((r) => r.title.invalid || r.startDate.invalid || r.totalSeats.invalid)
  .map(({ title, startDate, totalSeats }) => {
    const payload: Record<string, unknown> = {};
    if (title.value !== undefined) payload.title = title.value;
    if (startDate.value !== undefined) payload.startDate = startDate.value;
    if (totalSeats.value !== undefined) payload.totalSeats = totalSeats.value;
    const invalidFields: string[] = [];
    if (title.invalid) invalidFields.push('title');
    if (startDate.invalid) invalidFields.push('startDate');
    if (totalSeats.invalid) invalidFields.push('totalSeats');
    return { payload, invalidFields };
  });

// ---------------------------------------------------------------------------

describe('Property 32: Invalid payloads are rejected per-field before the handler', () => {
  let ctx: TestAppContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const jwtService = ctx.getService(JwtService);
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminToken = jwtService.sign({ sub: admin.id, role: Role.ADMINISTRATOR });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('POST /auth/register: rejects invalid bodies with 400, names each bad field, and creates no user', async () => {
    const baselineUsers = ctx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM users',
    )!.n;

    await fc.assert(
      fc.asyncProperty(invalidRegisterPayload, async ({ payload, invalidFields }) => {
        const response = await request(ctx.app.getHttpServer())
          .post('/auth/register')
          .send(payload);

        // 1. Rejected with HTTP 400 by the ValidationPipe.
        expect(response.status).toBe(400);

        // 2. Per-field reporting: a message array naming every corrupted field.
        const messages = messageArray(response.body);
        expect(messages.length).toBeGreaterThan(0);
        for (const field of invalidFields) {
          expect(mentionsField(messages, field)).toBe(true);
        }

        // 3. Handler did not run: no user persisted.
        const count = ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM users',
        )!.n;
        expect(count).toBe(baselineUsers);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('POST /events: rejects invalid bodies with 400, names each bad field, and creates no event', async () => {
    const baselineEvents = ctx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM events',
    )!.n;

    await fc.assert(
      fc.asyncProperty(invalidEventPayload, async ({ payload, invalidFields }) => {
        const response = await request(ctx.app.getHttpServer())
          .post('/events')
          .set('Authorization', `Bearer ${adminToken}`)
          .send(payload);

        // 1. Guard chain passed (valid admin token) -> the 400 is from validation.
        expect(response.status).toBe(400);

        // 2. Per-field reporting: a message array naming every corrupted field.
        const messages = messageArray(response.body);
        expect(messages.length).toBeGreaterThan(0);
        for (const field of invalidFields) {
          expect(mentionsField(messages, field)).toBe(true);
        }

        // 3. Handler did not run: no event persisted.
        const count = ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM events',
        )!.n;
        expect(count).toBe(baselineEvents);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('sanity: a fully valid register body reaches the handler and persists a user (no false 400s)', async () => {
    const login = `prop32-valid-${Date.now()}`;
    const response = await request(ctx.app.getHttpServer())
      .post('/auth/register')
      .send({ login, password: 'valid-password-123' });

    expect(response.status).toBe(201);
    const row = ctx.db.get<{ login: string }>(
      'SELECT login FROM users WHERE login = ?',
      [login],
    );
    expect(row?.login).toBe(login);
  });
});
