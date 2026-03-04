# Data Layout

Gears stores SQLite databases under `GEARS_DATA_DIR`.

## Default
If `GEARS_DATA_DIR` is not set, it defaults to `./.gears`.

## Files
- `jobs.sqlite` — queue
- `locks.sqlite` — distributed mutex locks
- `shared.sqlite` — shared DB for:
  - `IStore` key-value data
  - durable event bus events
  - metrics counters and gauges
- `app.sqlite` — app data (Kysely)
- `app.log` — runtime logs (via `PinoLogger`)

## App DB
The database bundle uses:
- `GEARS_APP_DB_PATH`
- default `app.sqlite`

If the value is not absolute, it is resolved inside `GEARS_DATA_DIR`.
