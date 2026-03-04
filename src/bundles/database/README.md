# Database Bundle

**Overview**
Provides the Kysely-backed SQLite connection used by data bundles.

**Provides**
- `db` as a `Kysely` instance backed by `better-sqlite3`.

**Depends On**
- Core `ILogger` for error logging.

**Environment**
- `GEARS_APP_DB_PATH` to control the SQLite path.
- Default DB file is `app.sqlite` under `GEARS_DATA_DIR`.
