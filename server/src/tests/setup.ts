import { afterAll, beforeEach } from 'vitest';
import { resetAuthRateLimits } from '../auth/rateLimit.js';
import pool from '../db.js';

// Safety net: these tests wipe every table before each test, so refuse to run
// against anything that isn't clearly a test database.
const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against "${databaseName}". The database name must end in "_test".`,
  );
}

// Start every test from empty tables and fresh login limits, so tests can't affect each other.
beforeEach(async () => {
  await pool.query('TRUNCATE users, repos, pets, events RESTART IDENTITY CASCADE');
  await resetAuthRateLimits();
});

afterAll(async () => {
  await pool.end();
});
