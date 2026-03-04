import Database from 'better-sqlite3';

/**
 * Creates a fresh in-memory SQLite database for use in tests.
 *
 * Returns a better-sqlite3 Database instance backed by ':memory:'.
 * Each call produces an isolated database — no shared state between tests.
 *
 * The returned instance satisfies the Database interface used by any
 * gears bundle that accepts a better-sqlite3 db (e.g. RoomLog, VectorBackedMemory).
 */
export function createTestDatabase(): Database.Database {
    return new Database(':memory:');
}
