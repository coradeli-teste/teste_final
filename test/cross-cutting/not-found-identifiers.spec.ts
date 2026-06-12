// Feature: event-ticket-reservation, Property 11: Operations on non-existent identifiers return 404
//
// Property 11: For any well-formed UUID that does not correspond to a stored
// record, each of the following operations returns HTTP 404 and makes no state
// change:
//   - role change of a target user        (UsersService.changeRole)
//   - event update                        (EventsService.update)
//   - event cancellation                  (EventsService.cancel)
//   - single-event read                   (EventsService.getById)
//   - reservation creation for an event   (ReservationsService.reserve)
//   - reservation cancellation            (ReservationsService.cancel)
//
// Each service resolves the existence check ahead of (or, for changeRole,
// behind only the authorization/validity guards which a seeded admin + valid
// role pass) any other branch, so a missing identifier surfaces as a
// NotFoundException (HTTP 404). A fresh real-v4 UUID is generated per run; the
// astronomically small odds of colliding with a stored id make it a guaranteed
// "non-existent identifier".
//
// Validates: Requirements 5.5, 8.4, 9.5, 10.7, 11.7, 12.5

import { HttpException, NotFoundException } from '@nestjs/common';
import fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';

import { AuthUser, Role } from '../../src/common/types';
import { UpdateEventDto } from '../../src/dto';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Any in-enum role value the administrator may assign (for the changeRole op). */
const roleArbitrary: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
);

/** A fully valid event-update payload (rejected only by the 404 existence check). */
const validUpdate: fc.Arbitrary<UpdateEventDto> = fc.record({
  title: fc
    .array(
      fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
      { minLength: 1, maxLength: 40 },
    )
    .map((chars) => chars.join('')),
  totalSeats: fc.integer({ min: 1, max: 1_000_000 }),
  startDate: fc
    .integer({ min: 1, max: 3650 })
    .map((days) => new Date(Date.now() + days * ONE_DAY_MS).toISOString()),
});

/**
 * The six operations under test, each described as a discriminated case. The
 * `role`/`update` payloads are valid so the only failing branch is the missing
 * identifier — isolating the 404-on-non-existent-id behaviour.
 */
type NotFoundCase =
  | { kind: 'change-role'; role: Role }
  | { kind: 'event-update'; update: UpdateEventDto }
  | { kind: 'event-cancel' }
  | { kind: 'event-get' }
  | { kind: 'reservation-create' }
  | { kind: 'reservation-cancel' };

const notFoundCase: fc.Arbitrary<NotFoundCase> = fc.oneof(
  roleArbitrary.map<NotFoundCase>((role) => ({ kind: 'change-role', role })),
  validUpdate.map<NotFoundCase>((update) => ({ kind: 'event-update', update })),
  fc.constant<NotFoundCase>({ kind: 'event-cancel' }),
  fc.constant<NotFoundCase>({ kind: 'event-get' }),
  fc.constant<NotFoundCase>({ kind: 'reservation-create' }),
  fc.constant<NotFoundCase>({ kind: 'reservation-cancel' }),
);

describe('Property 11: Operations on non-existent identifiers return 404', () => {
  let ctx: TestAppContext;
  let adminActor: AuthUser;
  let organizer: AuthUser;
  let buyer: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();

    // The administrator is seeded on startup; use it as the admin actor and to
    // promote an organizer.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Expected the seeded administrator to exist');
    }
    adminActor = { id: admin.id, role: admin.role };

    const org = ctx.users.register({
      login: `org-${uuidv4()}`,
      password: 'valid-password-123',
    });
    ctx.users.changeRole(adminActor, org.id, Role.ORGANIZER);
    organizer = { id: org.id, role: Role.ORGANIZER };

    const buy = ctx.users.register({
      login: `buyer-${uuidv4()}`,
      password: 'valid-password-123',
    });
    buyer = { id: buy.id, role: Role.BUYER };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** Count the rows in a table (state-change observability). */
  const countOf = (table: 'users' | 'events' | 'reservations'): number =>
    ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;

  it('returns HTTP 404 and makes no state change for any operation on a non-existent identifier', async () => {
    await fc.assert(
      fc.asyncProperty(notFoundCase, async (testCase) => {
        // A fresh, well-formed v4 UUID that is not stored anywhere.
        const missingId = uuidv4();

        // Observable state before the rejected operation.
        const before = {
          users: countOf('users'),
          events: countOf('events'),
          reservations: countOf('reservations'),
        };

        let thrown: unknown;
        try {
          switch (testCase.kind) {
            case 'change-role':
              // Admin actor + valid enum role + target != actor => the only
              // remaining branch is the missing-target 404 (Req 5.5).
              ctx.users.changeRole(adminActor, missingId, testCase.role);
              break;
            case 'event-update':
              // Existence is checked before ownership, so any actor hits 404
              // for a missing event (Req 8.4).
              ctx.events.update(organizer, missingId, testCase.update);
              break;
            case 'event-cancel':
              ctx.events.cancel(organizer, missingId); // Req 9.5
              break;
            case 'event-get':
              ctx.events.getById(missingId); // Req 10.7
              break;
            case 'reservation-create':
              ctx.reservations.reserve(buyer, missingId); // Req 11.7
              break;
            case 'reservation-cancel':
              ctx.reservations.cancel(buyer, missingId); // Req 12.5
              break;
          }
        } catch (error) {
          thrown = error;
        }

        // Every operation rejects a missing identifier with a 404.
        expect(thrown).toBeInstanceOf(NotFoundException);
        expect((thrown as HttpException).getStatus()).toBe(404);

        // No state change: row counts are identical before and after.
        expect(countOf('users')).toBe(before.users);
        expect(countOf('events')).toBe(before.events);
        expect(countOf('reservations')).toBe(before.reservations);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
