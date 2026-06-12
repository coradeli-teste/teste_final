// Feature: event-ticket-reservation, Task 18.3: Smoke tests for startup and documentation
//
// These are SMOKE tests (not property-based). They validate the startup and
// documentation criteria that are inherently example/integration shaped:
//
//   1. The default administrator is seeded exactly once and the seed is
//      idempotent across application restarts against the same database file
//      (Requirements 4.1, 4.2).
//   2. Seed / schema / config failures abort startup via named errors
//      (Requirements 4.3, 15.3, 15.6).
//   3. Schema creation completes during init/onModuleInit — before the server
//      would begin accepting requests (Requirement 15.2).
//   4. Configuration values resolve from the environment via @nestjs/config
//      (Requirement 15.5).
//   5. The Swagger/OpenAPI document describes every route the system exposes,
//      including request payload schemas, response schemas, and the full set of
//      documented status codes (Requirements 16.1, 16.2, 16.3, 16.4).
//
// Validates: Requirements 4.1, 4.2, 4.3, 15.2, 15.3, 15.5, 15.6, 16.1, 16.2, 16.3, 16.4

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import {
  validateEnvironment,
  ConfigValidationError,
} from '../../src/config/env.validation';
import {
  DatabaseService,
  SchemaInitializationError,
  SeedInitializationError,
} from '../../src/database/database.service';
import { Role } from '../../src/common/types';
import { createTestApp, TestAppContext } from '../support/test-app';

/** Shape of a persisted administrator row used in seed assertions. */
interface UserRow {
  id: string;
  login: string;
  password: string;
  role: number;
  status: string;
}

/** Remove a SQLite file together with its WAL/SHM sidecars. */
const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix;
    if (existsSync(file)) {
      try {
        rmSync(file);
      } catch {
        // Best-effort cleanup: a locked sidecar must not fail the test run.
      }
    }
  }
};

describe('Task 18.3: startup and documentation smoke tests', () => {
  // ---------------------------------------------------------------------------
  // 1. Administrator seed: exactly one admin, idempotent across restarts.
  //    (Requirements 4.1, 4.2)
  // ---------------------------------------------------------------------------
  describe('default administrator seed (Req 4.1, 4.2)', () => {
    // A FIXED database path reused across two app boots so we can prove the
    // seed is idempotent: the second boot must NOT create a duplicate admin.
    const dbPath = join(tmpdir(), `ett-smoke-restart-${uuidv4()}.sqlite`);

    /**
     * Boot a full application instance pointed at `dbPath`. Schema creation and
     * the administrator seed run during `app.init()` exactly as in production.
     */
    const bootApp = async () => {
      process.env.DATABASE_PATH = dbPath;
      process.env.SQLITE_PATH = dbPath;
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      return app;
    };

    afterAll(() => {
      removeDbFiles(dbPath);
    });

    it('seeds exactly one administrator and keeps it unchanged on restart', async () => {
      // --- First boot against a fresh database file -------------------------
      const app1 = await bootApp();
      const db1 = app1.get(DatabaseService);

      const adminsFirstBoot = db1.all<UserRow>(
        'SELECT id, login, password, role, status FROM users WHERE login = ?',
        ['administrator'],
      );

      // Exactly one administrator created with the documented credentials
      // (plain-text password) and Role ADMINISTRATOR (2) (Req 4.1).
      expect(adminsFirstBoot).toHaveLength(1);
      const seeded = adminsFirstBoot[0];
      expect(seeded.login).toBe('administrator');
      expect(seeded.password).toBe('administrator');
      expect(seeded.role).toBe(Role.ADMINISTRATOR);
      expect(seeded.role).toBe(2);
      expect(seeded.status).toBe('active');

      // Close the first connection BEFORE reopening — better-sqlite3 uses a
      // single connection per file.
      await app1.close();

      // --- Second boot against the SAME database file -----------------------
      const app2 = await bootApp();
      const db2 = app2.get(DatabaseService);

      const adminsSecondBoot = db2.all<UserRow>(
        'SELECT id, login, password, role, status FROM users WHERE login = ?',
        ['administrator'],
      );

      // Still exactly one administrator, and it is the SAME record — the seed
      // left the existing row unchanged and created no duplicate (Req 4.2).
      expect(adminsSecondBoot).toHaveLength(1);
      expect(adminsSecondBoot[0].id).toBe(seeded.id);
      expect(adminsSecondBoot[0].password).toBe('administrator');
      expect(adminsSecondBoot[0].role).toBe(Role.ADMINISTRATOR);

      await app2.close();
    });
  });

  // ---------------------------------------------------------------------------
  // 2a. Config failures abort startup (Req 15.6).
  // ---------------------------------------------------------------------------
  describe('configuration validation aborts startup (Req 15.6)', () => {
    it('throws ConfigValidationError when JWT_SECRET is missing', () => {
      expect(() => validateEnvironment({ DATABASE_PATH: 'x' })).toThrow(
        ConfigValidationError,
      );
    });

    it('throws ConfigValidationError when JWT_SECRET is empty or whitespace', () => {
      expect(() =>
        validateEnvironment({ DATABASE_PATH: 'x', JWT_SECRET: '' }),
      ).toThrow(ConfigValidationError);
      expect(() =>
        validateEnvironment({ DATABASE_PATH: 'x', JWT_SECRET: '   ' }),
      ).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when DATABASE_PATH is missing', () => {
      expect(() => validateEnvironment({ JWT_SECRET: 's3cret' })).toThrow(
        ConfigValidationError,
      );
    });

    it('names every missing key in the thrown error', () => {
      try {
        validateEnvironment({});
        throw new Error('expected validateEnvironment to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const message = (error as Error).message;
        expect(message).toContain('JWT_SECRET');
        expect(message).toContain('DATABASE_PATH');
      }
    });

    it('returns the normalized config when all required values are present', () => {
      const env = validateEnvironment({
        JWT_SECRET: 's3cret',
        DATABASE_PATH: 'data/app.db',
      });
      expect(env.JWT_SECRET).toBe('s3cret');
      expect(env.DATABASE_PATH).toBe('data/app.db');
      expect(env.PORT).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2b. Schema failure aborts startup via SchemaInitializationError (Req 15.3).
  // ---------------------------------------------------------------------------
  describe('schema initialization failure aborts startup (Req 15.3)', () => {
    it('re-raises a CREATE TABLE failure as SchemaInitializationError from onModuleInit', () => {
      const dbPath = join(tmpdir(), `ett-smoke-schema-${uuidv4()}.sqlite`);
      process.env.DATABASE_PATH = dbPath;
      process.env.SQLITE_PATH = dbPath;

      const service = new DatabaseService();
      try {
        // Inject a deterministic fault: any CREATE TABLE statement throws when
        // prepared, simulating a schema-creation failure. Other statements
        // (BEGIN/COMMIT/ROLLBACK) behave normally so the transaction unwinds.
        const realPrepare = service.connection.prepare.bind(service.connection);
        const spy = jest
          .spyOn(service.connection, 'prepare')
          .mockImplementation((sql: string) => {
            if (typeof sql === 'string' && sql.includes('CREATE TABLE')) {
              throw new Error('simulated CREATE TABLE failure');
            }
            return realPrepare(sql);
          });

        // onModuleInit runs schema creation first; the fault must abort it with
        // the named error class so Nest bootstrap fails before listening.
        expect(() => service.onModuleInit()).toThrow(SchemaInitializationError);

        spy.mockRestore();
      } finally {
        service.onModuleDestroy();
        removeDbFiles(dbPath);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2c. Seed failure aborts startup via SeedInitializationError, leaving no
  //     partial administrator record (Req 4.3).
  // ---------------------------------------------------------------------------
  describe('administrator seed failure aborts startup (Req 4.3)', () => {
    it('re-raises an insert failure as SeedInitializationError and persists no admin', () => {
      const dbPath = join(tmpdir(), `ett-smoke-seed-${uuidv4()}.sqlite`);
      process.env.DATABASE_PATH = dbPath;
      process.env.SQLITE_PATH = dbPath;

      const service = new DatabaseService();
      try {
        // Inject a deterministic fault into the seed INSERT only. Schema
        // creation uses the connection directly and is unaffected, so tables
        // are created successfully and then the seed insert fails.
        const spy = jest
          .spyOn(service, 'run')
          .mockImplementation(() => {
            throw new Error('simulated administrator insert failure');
          });

        expect(() => service.onModuleInit()).toThrow(SeedInitializationError);

        spy.mockRestore();

        // The failed seed transaction rolled back: no administrator persisted
        // (no partial record left behind) (Req 4.3).
        const admins = service.all<UserRow>(
          'SELECT id FROM users WHERE login = ?',
          ['administrator'],
        );
        expect(admins).toHaveLength(0);
      } finally {
        service.onModuleDestroy();
        removeDbFiles(dbPath);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3 & 4. Schema runs before listening (Req 15.2) and config resolves from
  //        env (Req 15.5), verified on a fully initialized app.
  // ---------------------------------------------------------------------------
  describe('schema and configuration are ready after init (Req 15.2, 15.5)', () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it('creates the users/events/reservations tables during init (Req 15.2)', () => {
      // app.init() has completed (no listen needed). The tables must already
      // exist, proving schema creation ran during onModuleInit — before the
      // server would accept HTTP requests.
      const tables = ctx.db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .map((row) => row.name);

      expect(tables).toEqual(
        expect.arrayContaining(['users', 'events', 'reservations']),
      );
    });

    it('resolves JWT_SECRET and DATABASE_PATH from the environment (Req 15.5)', () => {
      const config = ctx.getService(ConfigService);
      // The configuration module exposes values sourced from the environment.
      // JWT_SECRET is resolved straight from the process environment.
      expect(config.get<string>('JWT_SECRET')).toBe(process.env.JWT_SECRET);
      // DATABASE_PATH is resolved through the config module to a non-empty
      // string (its concrete value comes from the environment / .env source).
      const databasePath = config.get<string>('DATABASE_PATH');
      expect(typeof databasePath).toBe('string');
      expect((databasePath as string).length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Swagger UI documents every route's payloads, responses, and status
  //    codes (Req 16.1, 16.2, 16.3, 16.4).
  // ---------------------------------------------------------------------------
  describe('Swagger/OpenAPI documentation (Req 16.1-16.4)', () => {
    // This block manages its own application instance so the Swagger document
    // can be mounted BEFORE app.init(), making /docs and /docs-json reachable
    // over HTTP (the shared harness already initializes its app).
    const dbPath = join(tmpdir(), `ett-smoke-docs-${uuidv4()}.sqlite`);
    let app: import('@nestjs/common').INestApplication;
    // OpenAPI document type is loosely typed here for ergonomic assertions.
    let document: Record<string, any>;

    beforeAll(async () => {
      process.env.DATABASE_PATH = dbPath;
      process.env.SQLITE_PATH = dbPath;
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();

      // Build the OpenAPI document the same way main.ts does, then mount it
      // BEFORE init so the documentation routes are served over HTTP.
      const config = new DocumentBuilder()
        .setTitle('Event Ticket Reservation API')
        .setVersion('1.0')
        .addBearerAuth()
        .build();
      document = SwaggerModule.createDocument(app, config) as Record<
        string,
        any
      >;
      SwaggerModule.setup('docs', app, document);

      await app.init();
    });

    afterAll(async () => {
      await app.close();
      removeDbFiles(dbPath);
    });

    it('documents a path entry for every route the system exposes (Req 16.1)', () => {
      const expectedPaths = [
        '/auth/register',
        '/auth/login',
        '/users/me',
        '/users/{id}/role',
        '/events',
        '/events/{id}',
        '/events/{id}/reservations',
        '/reservations/{id}',
        '/reservations/me',
      ];
      for (const path of expectedPaths) {
        expect(document.paths[path]).toBeDefined();
      }
    });

    it('documents request payload schemas derived from DTOs (Req 16.2)', () => {
      // POST /auth/register references RegisterUserDto, whose schema lists the
      // login and password properties with their types.
      const register = document.paths['/auth/register'].post;
      expect(register.requestBody).toBeDefined();
      const ref =
        register.requestBody.content['application/json'].schema.$ref;
      expect(ref).toBe('#/components/schemas/RegisterUserDto');

      const registerSchema = document.components.schemas.RegisterUserDto;
      expect(registerSchema.properties.login).toBeDefined();
      expect(registerSchema.properties.login.type).toBe('string');
      expect(registerSchema.properties.password).toBeDefined();
      expect(registerSchema.properties.password.type).toBe('string');

      // POST /auth/login references LoginDto with login/password too.
      const login = document.paths['/auth/login'].post;
      expect(login.requestBody.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/LoginDto',
      );
      const loginSchema = document.components.schemas.LoginDto;
      expect(loginSchema.properties.login).toBeDefined();
      expect(loginSchema.properties.password).toBeDefined();
    });

    it('documents response body schemas for representative routes (Req 16.3)', () => {
      // GET /events returns an array of EventView; the 200 response carries a
      // schema, and the EventView component lists its fields.
      const listOk = document.paths['/events'].get.responses['200'];
      expect(listOk).toBeDefined();
      expect(listOk.content['application/json'].schema).toBeDefined();

      const eventView = document.components.schemas.EventView;
      expect(eventView).toBeDefined();
      for (const field of [
        'id',
        'title',
        'startDate',
        'totalSeats',
        'remainingSeats',
        'status',
        'soldOut',
      ]) {
        expect(eventView.properties[field]).toBeDefined();
      }

      // POST /events/{id}/reservations documents an inline response object
      // schema with reservationId and remainingSeats.
      const reserveCreated =
        document.paths['/events/{id}/reservations'].post.responses['201'];
      const reserveSchema =
        reserveCreated.content['application/json'].schema;
      expect(reserveSchema.properties.reservationId).toBeDefined();
      expect(reserveSchema.properties.remainingSeats).toBeDefined();
    });

    it('documents every status code each route can return (Req 16.4)', () => {
      const expectedStatusCodes: Record<string, string[]> = {
        '/auth/register|post': ['201', '400', '409'],
        '/auth/login|post': ['200', '400', '401', '503'],
        '/users/me|patch': ['200', '400', '401', '403'],
        '/users/{id}/role|patch': ['200', '400', '401', '403', '404'],
        '/events|post': ['201', '400', '401', '403'],
        '/events/{id}|patch': ['200', '400', '401', '403', '404'],
        '/events/{id}|delete': ['200', '400', '401', '403', '404', '409'],
        '/events/{id}|get': ['200', '400', '404'],
        '/events/{id}/reservations|post': ['201', '400', '401', '404', '409'],
        '/reservations/{id}|delete': [
          '200',
          '400',
          '401',
          '403',
          '404',
          '409',
          '500',
        ],
        '/reservations/me|get': ['200', '401'],
      };

      for (const [key, codes] of Object.entries(expectedStatusCodes)) {
        const [path, method] = key.split('|');
        const operation = document.paths[path][method];
        expect(operation).toBeDefined();
        for (const code of codes) {
          expect(operation.responses[code]).toBeDefined();
        }
      }
    });

    it('serves the Swagger UI at /docs and the raw document at /docs-json', async () => {
      const server = app.getHttpServer();

      const docsJson = await request(server).get('/docs-json');
      expect(docsJson.status).toBe(200);
      expect(docsJson.body.paths['/auth/register']).toBeDefined();

      const docsUi = await request(server).get('/docs');
      // The UI route responds (200 for the HTML shell, or a 3xx redirect to the
      // trailing-slash variant depending on the adapter).
      expect([200, 301, 302]).toContain(docsUi.status);
    });
  });
});
