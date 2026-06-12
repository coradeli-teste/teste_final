// Feature: event-ticket-reservation, Property 7: Role authorization is exact-membership
//
// Property 7: For any route that declares a required-role set and any
// authenticated user role, the request is permitted if and only if the user's
// role is a member of the declared required-role set; otherwise it is rejected
// with HTTP 403 and the handler is not executed.
//
// Two routes with distinct declared sets are exercised over supertest to
// substantiate the exact-membership claim:
//   - POST /events            declares @Roles(ORGANIZER, ADMINISTRATOR)
//   - PATCH /users/:id/role   declares @Roles(ADMINISTRATOR)
//
// For each route and each authenticated role in {BUYER, ORGANIZER,
// ADMINISTRATOR} we register a user, promote it to the generated role via the
// seeded administrator, mint a valid JWT for that user, and call the route with
// a VALID request body. A valid body isolates the role check from payload
// validation: an authorized role reaches the handler and yields a non-403
// status, while an unauthorized role is rejected with exactly 403 (never 400 or
// a 2xx), proving the handler never executed.
//
// Validates: Requirements 3.4, 3.5

import { JwtService } from '@nestjs/jwt';
import fc from 'fast-check';
import request from 'supertest';

import { AuthUser, Role } from '../../src/common/types';
import { uniqueValidLogin, validPasswordArbitrary } from '../support/arbitraries';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Minimum iterations mandated by the spec for every property test. */
const NUM_RUNS = 100;

/** Every authenticated role the property ranges over. */
const anyRole: fc.Arbitrary<Role> = fc.constantFrom(
  Role.BUYER,
  Role.ORGANIZER,
  Role.ADMINISTRATOR,
);

/** A valid CreateEventDto body so authorized roles pass body validation. */
const validCreateEventBody = () => ({
  title: 'Property 7 Event',
  description: 'Role authorization exact-membership probe',
  startDate: '2999-01-01T00:00:00.000Z',
  totalSeats: 100,
});

describe('Property 7: Role authorization is exact-membership', () => {
  let ctx: TestAppContext;
  let jwtService: JwtService;
  let adminActor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    jwtService = ctx.getService(JwtService);

    // The startup seed creates exactly one administrator; use it as the actor
    // that promotes freshly registered (BUYER) users to the generated role.
    const admin = ctx.users.findByLogin('administrator');
    if (!admin) {
      throw new Error('Administrator seed not found in test database');
    }
    adminActor = { id: admin.id, role: Role.ADMINISTRATOR };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /**
   * Register a user, promote it to {@link desiredRole}, and return a valid
   * bearer token carrying that role for use over supertest.
   */
  const mintUserToken = (
    login: string,
    password: string,
    desiredRole: Role,
  ): { id: string; token: string } => {
    const { id } = ctx.users.register({ login, password });
    if (desiredRole !== Role.BUYER) {
      ctx.users.changeRole(adminActor, id, desiredRole);
    }
    const token = jwtService.sign({ sub: id, role: desiredRole });
    return { id, token };
  };

  it('POST /events (required {ORGANIZER, ADMINISTRATOR}) permits iff role is a member, else 403', async () => {
    const requiredSet = [Role.ORGANIZER, Role.ADMINISTRATOR];

    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        anyRole,
        async (login, password, role) => {
          const { token } = mintUserToken(login, password, role);

          const response = await request(ctx.app.getHttpServer())
            .post('/events')
            .set('Authorization', `Bearer ${token}`)
            .send(validCreateEventBody());

          const isMember = requiredSet.includes(role);
          if (isMember) {
            // Authorized: the role guard let the request through to the
            // handler, which created the event. Never a 403.
            expect(response.status).not.toBe(403);
            expect(response.status).toBe(201);
          } else {
            // Unauthorized (BUYER): rejected by the role guard with exactly
            // 403 before the handler ran — not a 400 (body was valid) and not
            // a 2xx (handler never executed).
            expect(response.status).toBe(403);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('PATCH /users/:id/role (required {ADMINISTRATOR}) permits iff role is ADMINISTRATOR, else 403', async () => {
    const requiredSet = [Role.ADMINISTRATOR];

    await fc.assert(
      fc.asyncProperty(
        uniqueValidLogin,
        validPasswordArbitrary,
        uniqueValidLogin,
        validPasswordArbitrary,
        anyRole,
        async (actorLogin, actorPassword, targetLogin, targetPassword, role) => {
          const { token } = mintUserToken(actorLogin, actorPassword, role);

          // A distinct target user so the service's self-change guard (403)
          // cannot confound the role-membership check.
          const { id: targetId } = ctx.users.register({
            login: targetLogin,
            password: targetPassword,
          });

          const response = await request(ctx.app.getHttpServer())
            .patch(`/users/${targetId}/role`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: Role.ORGANIZER });

          const isMember = requiredSet.includes(role);
          if (isMember) {
            // Authorized administrator: the role guard let the request reach
            // the handler, which changed the target's role. Never a 403.
            expect(response.status).not.toBe(403);
            expect(response.status).toBe(200);
          } else {
            // Unauthorized (BUYER or ORGANIZER): exactly 403 from the role
            // guard, with a valid body, so the handler never executed.
            expect(response.status).toBe(403);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
