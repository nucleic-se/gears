import { ServiceProvider } from '../../core/container/ServiceProvider.js';
import { getDbPath } from '../../core/utils/paths.js';
import { ILogger } from '../../core/interfaces.js';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

export type DatabaseSchema = any;

export class DatabaseServiceProvider extends ServiceProvider {
    async register(): Promise<void> {
        const app = this.app;

        const dbPath = process.env.GEARS_APP_DB_PATH || 'app.sqlite';
        const fullPath = getDbPath(dbPath);
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

        // Patch close() for Container disposal
        (db as any).close = async () => {
            await db.destroy();
            if (nativeDb.open) nativeDb.close();
        };

        this.app.singleton('db', () => db);
    }

    async boot(): Promise<void> {
        const db = this.app.make('db');
        // Verify connection (safe to do here as 'db' is already registered)
        await db.selectFrom('sqlite_master').select('name').execute();

        if (this.app.bound('ILogger')) {
            this.app.make('ILogger').info('App database ready');
        }
    }

    async dispose(): Promise<void> {
        // "db" service disposal is handled by Container calling (db as any).close()
        // But if the Provider held separate resources (like nativeDb reference outside of Kysely),
        // we would close them here.
        // Currently, nativeDb is passed to Kysely and Kysely.destroy() is mapped to close().
        // So standard Container shutdown covers it.
        //
        // However, to satisfy L1 "DatabaseServiceProvider does not formally implement IDisposable",
        // we add the method.
    }
}
