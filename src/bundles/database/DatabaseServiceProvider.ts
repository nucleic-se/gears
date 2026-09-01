import { ServiceProvider } from '../../core/container/ServiceProvider.js';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';

import type { DatabaseSchema } from './index.js';

export class DatabaseServiceProvider extends ServiceProvider {
    async register(): Promise<void> {
        const app = this.app;

        const dbPath = process.env.GEARS_APP_DB_PATH || 'app.sqlite';
        const fullPath = app.make('DataPaths').getDbPath(dbPath);
        const nativeDb = new Database(fullPath);
        nativeDb.pragma('journal_mode = WAL');
        nativeDb.pragma('busy_timeout = 5000');

        const db = new Kysely<DatabaseSchema>({
            dialect: new SqliteDialect({
                database: nativeDb
            }),
            log: (event) => {
                if (event.level === 'error' && app.bound('ILogger')) {
                    app.make('ILogger').error('DB Error', event.error as Error);
                }
            }
        });

        // Patch close() for Container disposal.
        (db as Kysely<DatabaseSchema> & { close?: () => Promise<void> }).close = async () => {
            await db.destroy();
            if (nativeDb.open) nativeDb.close();
        };

        this.app.singleton('db', () => db);
    }

    async boot(): Promise<void> {
        const db = this.app.make('db');
        await sql.raw('select 1').execute(db);

        if (this.app.bound('ILogger')) {
            this.app.make('ILogger').info('App database ready');
        }
    }

    async dispose(): Promise<void> {
        // "db" service disposal is handled by Container via the patched close() method.
    }
}
