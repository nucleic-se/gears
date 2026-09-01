# Data Layout

Each Gears container owns one immutable data root. `boot({ dataDir })` takes
precedence over `GEARS_DATA_DIR`; changing or booting another container cannot
redirect services already registered in the first container.

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

The shared SQLite connection is private infrastructure. Store, scheduler,
durable-event, and metrics consumers receive narrow service interfaces and cannot
execute SQL or close the connection behind one another.
