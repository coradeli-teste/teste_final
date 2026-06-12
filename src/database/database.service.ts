import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Role } from '../common/types';

export class SchemaInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaInitializationError';
  }
}

export class SeedInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SeedInitializationError';
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

const DEFAULT_SQLITE_PATH = 'event-tickets.sqlite';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly db: Database.Database;

  

  constructor() {
    const sqlitePath = process.env.DATABASE_PATH?.trim() || DEFAULT_SQLITE_PATH;
    const directory = dirname(sqlitePath);
    if (directory && directory !== '.' && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    this.db = new Database(sqlitePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.logger.log(`SQLite connection opened at "${sqlitePath}"`);
  }

  get connection(): Database.Database {
    return this.db;
  }

  onModuleInit(): void {
    this.initializeSchema();
    this.seedAdministrator();
  }

  private initializeSchema(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        login       TEXT NOT NULL,
        password    TEXT NOT NULL,
        role        INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_active
        ON users(login) WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        start_date      TEXT NOT NULL,
        total_seats     INTEGER NOT NULL,
        remaining_seats INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        CHECK (total_seats >= 1 AND total_seats <= 1000000),
        CHECK (remaining_seats >= 0 AND remaining_seats <= total_seats),
        FOREIGN KEY (owner_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS reservations (
        id                    TEXT PRIMARY KEY,
        user_id               TEXT NOT NULL,
        event_id              TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active',
        event_status_snapshot TEXT NOT NULL DEFAULT 'active',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_reservation_user_event_active
        ON reservations(user_id, event_id) WHERE status = 'active'`,
    ];

    try {
      this.transaction(() => {
        for (const statement of statements) {
          this.db.prepare(statement).run();
        }
      });
      this.logger.log('Database schema initialized');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Schema initialization failed: ${message}`);
      throw new SchemaInitializationError(
        `Schema initialization failed: ${message}`,
        { cause: error },
      );
    }
  }

  private seedAdministrator(): void {
    try {
      this.transaction(() => {
        const existing = this.get<{ id: string }>(
          'SELECT id FROM users WHERE login = ?',
          ['administrator'],
        );

        if (existing) {
          return;
        }

        const now = new Date().toISOString();
        this.run(
          `INSERT INTO users (id, login, password, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [
            uuidv4(),
            'administrator',
            'administrator',
            Role.ADMINISTRATOR,
            now,
            now,
          ],
        );
        this.logger.log('Default administrator seeded');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Administrator seed failed: ${message}`);
      throw new SeedInitializationError(
        `Administrator seed failed: ${message}`,
        { cause: error },
      );
    }
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const info = this.db.prepare(sql).run(...(params as never[]));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = fn();
      this.db.prepare('COMMIT').run();
      return result;
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }
  }

  onModuleDestroy(): void {
    if (this.db.open) {
      this.db.close();
      this.logger.log('SQLite connection closed');
    }
  }

}
