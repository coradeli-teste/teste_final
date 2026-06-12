/**
 * Shared test harness for the Event Ticket Reservation spec.
 *
 * This module is the single entry point every test task (13.x–18.x) uses to
 * boot an isolated instance of the application against its own throwaway SQLite
 * database. It exists so that property tests can run many iterations against
 * real services (no mocks) while staying fast and fully independent of one
 * another.
 *
 * ## Isolation strategy
 * The {@link DatabaseService} opens its connection from `process.env.DATABASE_PATH`
 * (falling back to `SQLITE_PATH`, then a default) at construction time. Before
 * compiling the Nest module we point those variables at a unique temp file under
 * `os.tmpdir()` named with a fresh UUID, and we pin `JWT_SECRET` to a fixed test
 * value so config validation passes. `@nestjs/config` loads `.env` via dotenv,
 * which never overrides variables already present in `process.env`, so the path
 * we set always wins. Every call to {@link createTestApp} therefore gets its own
 * database file — parallel or sequential tests cannot interfere.
 *
 * ## API
 * ```ts
 * const ctx = await createTestApp();
 * try {
 *   const { id } = ctx.users.register({ login, password });
 *   const row = ctx.db.get('SELECT * FROM users WHERE id = ?', [id]);
 *   const someService = ctx.getService(SomeService); // any provider token
 * } finally {
 *   await ctx.cleanup(); // closes the app and deletes the temp DB files
 * }
 * ```
 *
 * - `ctx.app`     — the initialized Nest application (use for supertest, etc.).
 * - `ctx.db`      — the raw {@link DatabaseService} for direct SQL assertions.
 * - `ctx.users` / `ctx.auth` / `ctx.events` / `ctx.reservations` — domain
 *   services for unit-style property tests.
 * - `ctx.getService(token)` — resolve any provider from the DI container.
 * - `ctx.dbPath` — the temp database file path (for diagnostics).
 * - `ctx.cleanup()` — MUST be called (typically in `afterEach`/`finally`) to
 *   close the connection and remove the temp DB (`.sqlite`, `-wal`, `-shm`).
 */
import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/database/database.service';
import { UsersService } from '../../src/users/users.service';
import { AuthService } from '../../src/auth/auth.service';
import { EventsService } from '../../src/events/events.service';
import { ReservationsService } from '../../src/reservations/reservations.service';

/** Fixed JWT secret used by the test harness when none is already configured. */
const TEST_JWT_SECRET = 'test-jwt-secret';

/** Handle returned by {@link createTestApp}. */
export interface TestAppContext {
  /** The initialized Nest application (for supertest / integration tests). */
  app: INestApplication;
  /** Raw database service for direct SQL assertions against persisted state. */
  db: DatabaseService;
  /** Resolve any provider from the DI container by its injection token. */
  getService: <T>(token: Type<T> | string | symbol) => T;
  /** Convenience handle to the Users domain service. */
  users: UsersService;
  /** Convenience handle to the Auth domain service. */
  auth: AuthService;
  /** Convenience handle to the Events domain service. */
  events: EventsService;
  /** Convenience handle to the Reservations domain service. */
  reservations: ReservationsService;
  /** Absolute path of the isolated temp SQLite file backing this app. */
  dbPath: string;
  /** Close the app and delete the temp database files. Always call this. */
  cleanup: () => Promise<void>;
}

/**
 * Boot an isolated application instance backed by a fresh temp SQLite database.
 *
 * Each invocation generates a unique database path so independent tests never
 * share state. Schema creation and the administrator seed run during
 * `app.init()` exactly as in production.
 */
export async function createTestApp(): Promise<TestAppContext> {
  const dbPath = join(tmpdir(), `ett-test-${uuidv4()}.sqlite`);

  // Point the database at the isolated file BEFORE the module is compiled, so
  // DatabaseService's constructor opens this temp database. Set both the
  // primary and legacy keys the service understands.
  process.env.DATABASE_PATH = dbPath;
  process.env.SQLITE_PATH = dbPath;
  // Ensure config validation has a JWT secret without clobbering an existing one.
  process.env.JWT_SECRET = process.env.JWT_SECRET || TEST_JWT_SECRET;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const db = app.get(DatabaseService);

  const cleanup = async (): Promise<void> => {
    await app.close();
    // Remove the SQLite file plus its WAL/SHM sidecars.
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

  return {
    app,
    db,
    getService: <T>(token: Type<T> | string | symbol): T => app.get(token),
    users: app.get(UsersService),
    auth: app.get(AuthService),
    events: app.get(EventsService),
    reservations: app.get(ReservationsService),
    dbPath,
    cleanup,
  };
}
