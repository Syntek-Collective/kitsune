// Reads the events the mood rules need from the database and hands them to getMood.
import type { EventType, Mood } from '@kitsune/shared';
import pool from './db.js';
import { getMood, type MoodEvent } from './mood.js';

type LatestEventRow = { repo_id: number; type: EventType; created_at: Date };

// Works out the mood for several repos with one query. Every ID passed in gets an answer;
// a repo with no events comes back as "normal".
export const getMoodsForRepos = async (
  repoIds: number[],
  now: Date = new Date(),
): Promise<Map<number, Mood>> => {
  const eventsByRepo = new Map<number, MoodEvent[]>(repoIds.map((id) => [id, []]));

  if (repoIds.length > 0) {
    // The rules only ever look at the newest event of each type (the latest test run is the
    // newer of the latest pass and the latest failure), so that is all we fetch: at most
    // three rows per repo, however long its history is.
    // Test runs that weren't on the repo's default branch don't count (see webhooks/events.ts).
    // Runs saved before the branch was recorded have no onDefaultBranch, so they still count.
    const result = await pool.query<LatestEventRow>(
      `SELECT DISTINCT ON (repo_id, type) repo_id, type, created_at
       FROM events
       WHERE repo_id = ANY($1)
         AND NOT details @> '{"onDefaultBranch": false}'
       ORDER BY repo_id, type, created_at DESC`,
      [repoIds],
    );

    for (const row of result.rows) {
      eventsByRepo.get(row.repo_id)?.push({ type: row.type, createdAt: row.created_at });
    }
  }

  return new Map([...eventsByRepo].map(([repoId, events]) => [repoId, getMood(events, now)]));
};

export const getMoodForRepo = async (repoId: number, now: Date = new Date()): Promise<Mood> => {
  const moods = await getMoodsForRepos([repoId], now);
  return moods.get(repoId) ?? 'normal';
};
