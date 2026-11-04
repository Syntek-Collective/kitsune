import type { EventType } from '@kitsune/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../app.js';
import pool from '../db.js';
import { getMood, HAPPY_WINDOW_DAYS, type MoodEvent } from '../mood.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-10T12:00:00Z');

// Makes a pretend event that happened some number of days before `now`.
const event = (type: EventType, daysAgo: number): MoodEvent => ({
  type,
  createdAt: new Date(now.getTime() - daysAgo * DAY_MS),
});

describe('getMood', () => {
  it('is normal when there are no events yet', () => {
    expect(getMood([], now)).toBe('normal');
  });

  describe('sick: the most recent test run failed', () => {
    it('is sick after one failed test run', () => {
      expect(getMood([event('tests_failed', 1)], now)).toBe('sick');
    });

    it('stays sick however long ago the failure was, until the tests pass', () => {
      expect(getMood([event('tests_failed', 30)], now)).toBe('sick');
    });

    it('is cured as soon as the tests pass again', () => {
      const events = [event('tests_failed', 2), event('tests_passed', 1)];

      expect(getMood(events, now)).toBe('happy');
    });

    it('is sick again when a failure follows a pass', () => {
      const events = [event('tests_passed', 2), event('tests_failed', 1)];

      expect(getMood(events, now)).toBe('sick');
    });

    it('is not cured by a merged pull request', () => {
      const events = [event('tests_failed', 2), event('pr_merged', 1)];

      expect(getMood(events, now)).toBe('sick');
    });

    it('goes by time, not by the order of the list', () => {
      const events = [event('tests_passed', 1), event('tests_failed', 2)];

      expect(getMood(events, now)).toBe('happy');
    });
  });

  describe(`happy: good news in the last ${HAPPY_WINDOW_DAYS} days`, () => {
    it.each(['pr_merged', 'tests_passed'] as const)('is happy after a recent %s', (type) => {
      expect(getMood([event(type, 1)], now)).toBe('happy');
    });

    it('is still happy just inside the window', () => {
      expect(getMood([event('pr_merged', HAPPY_WINDOW_DAYS - 0.01)], now)).toBe('happy');
    });

    it('goes back to normal once the good news is older than the window', () => {
      expect(getMood([event('pr_merged', HAPPY_WINDOW_DAYS + 0.01)], now)).toBe('normal');
    });

    it('is normal when the tests last passed long ago and nothing has happened since', () => {
      const events = [event('tests_failed', 40), event('tests_passed', 30)];

      expect(getMood(events, now)).toBe('normal');
    });
  });

  it('does not rearrange the list it was given', () => {
    const events = [event('pr_merged', 3), event('tests_passed', 1), event('pr_merged', 2)];
    const before = [...events];

    getMood(events, now);

    expect(events).toEqual(before);
  });
});

describe('mood in the API', () => {
  // Signs up a user with one connected repo and a pet.
  const setUp = async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'fox@example.com', password: 'hunter2!!' });
    const connect = await agent.post('/api/repos').send({ fullName: 'fox/den' });
    const repoId: number = connect.body.id;
    await agent.post(`/api/repos/${repoId}/pet`).send({ name: 'Kitsu', character: 'kitsune' });

    return { agent, repoId };
  };

  // Adds an event row directly, dated some number of days before the real current time.
  const addEvent = async (repoId: number, type: EventType, daysAgo: number, details = {}) => {
    await pool.query(
      `INSERT INTO events (repo_id, type, github_delivery_id, created_at, details)
       VALUES ($1, $2, gen_random_uuid()::text, now() - make_interval(secs => $3), $4)`,
      [repoId, type, daysAgo * 24 * 60 * 60, JSON.stringify(details)],
    );
  };

  const onDefaultBranch = { onDefaultBranch: true };
  const onOtherBranch = { onDefaultBranch: false };

  const moods = async (agent: ReturnType<typeof request.agent>, repoId: number) => {
    const pet = await agent.get(`/api/repos/${repoId}/pet`);
    const repos = await agent.get('/api/repos');
    return { petView: pet.body.mood, repoCard: repos.body[0].pet.mood };
  };

  it('is normal before any events arrive', async () => {
    const { agent, repoId } = await setUp();

    expect(await moods(agent, repoId)).toEqual({ petView: 'normal', repoCard: 'normal' });
  });

  it('is sick on both the pet view and the repo card after a failed test run', async () => {
    const { agent, repoId } = await setUp();
    await addEvent(repoId, 'tests_failed', 1);

    expect(await moods(agent, repoId)).toEqual({ petView: 'sick', repoCard: 'sick' });
  });

  it('is happy on both after a recent merged pull request', async () => {
    const { agent, repoId } = await setUp();
    await addEvent(repoId, 'pr_merged', 1);

    expect(await moods(agent, repoId)).toEqual({ petView: 'happy', repoCard: 'happy' });
  });

  it('finds the latest test run behind a long history of newer merges', async () => {
    const { agent, repoId } = await setUp();
    await addEvent(repoId, 'tests_passed', 20);
    await addEvent(repoId, 'tests_failed', 10);
    for (let daysAgo = 9; daysAgo >= 1; daysAgo--) await addEvent(repoId, 'pr_merged', daysAgo);

    expect(await moods(agent, repoId)).toEqual({ petView: 'sick', repoCard: 'sick' });
  });

  it('is normal once the good news is older than the window', async () => {
    const { agent, repoId } = await setUp();
    await addEvent(repoId, 'pr_merged', HAPPY_WINDOW_DAYS + 1);

    expect(await moods(agent, repoId)).toEqual({ petView: 'normal', repoCard: 'normal' });
  });

  it('works out each repo separately', async () => {
    const { agent, repoId: sickRepo } = await setUp();
    const second = await agent.post('/api/repos').send({ fullName: 'fox/second-den' });
    const happyRepo: number = second.body.id;
    await agent.post(`/api/repos/${happyRepo}/pet`).send({ name: 'Mochi', character: 'kitsune' });
    await addEvent(sickRepo, 'tests_failed', 1);
    await addEvent(happyRepo, 'tests_passed', 1);

    const repos = await agent.get('/api/repos');

    expect(repos.body.map((repo: { pet: { mood: string } }) => repo.pet.mood)).toEqual([
      'sick',
      'happy',
    ]);
  });

  describe('only test runs on the default branch count', () => {
    it('is not made sick by a failed run on another branch', async () => {
      const { agent, repoId } = await setUp();
      await addEvent(repoId, 'tests_passed', 2, onDefaultBranch);
      await addEvent(repoId, 'tests_failed', 1, onOtherBranch);

      expect(await moods(agent, repoId)).toEqual({ petView: 'happy', repoCard: 'happy' });
    });

    it('is not cured by a passing run on another branch', async () => {
      const { agent, repoId } = await setUp();
      await addEvent(repoId, 'tests_failed', 2, onDefaultBranch);
      await addEvent(repoId, 'tests_passed', 1, onOtherBranch);

      expect(await moods(agent, repoId)).toEqual({ petView: 'sick', repoCard: 'sick' });
    });

    it('is not made happy by a passing run on another branch', async () => {
      const { agent, repoId } = await setUp();
      await addEvent(repoId, 'tests_passed', 1, onOtherBranch);

      expect(await moods(agent, repoId)).toEqual({ petView: 'normal', repoCard: 'normal' });
    });

    it('is sick when the default branch fails', async () => {
      const { agent, repoId } = await setUp();
      await addEvent(repoId, 'tests_passed', 2, onOtherBranch);
      await addEvent(repoId, 'tests_failed', 1, onDefaultBranch);

      expect(await moods(agent, repoId)).toEqual({ petView: 'sick', repoCard: 'sick' });
    });

    it('still counts runs saved before the branch was recorded', async () => {
      const { agent, repoId } = await setUp();
      await addEvent(repoId, 'tests_failed', 1);

      expect(await moods(agent, repoId)).toEqual({ petView: 'sick', repoCard: 'sick' });
    });
  });

  it('returns the mood when the pet is renamed', async () => {
    const { agent, repoId } = await setUp();
    await addEvent(repoId, 'tests_failed', 1);

    const res = await agent.patch(`/api/repos/${repoId}/pet`).send({ name: 'Mochi' });

    expect(res.body.mood).toBe('sick');
  });
});
