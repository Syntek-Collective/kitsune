import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../app.js';
import pool from '../db.js';
import { isValidSignature, signPayload } from '../webhooks/signature.js';

// Signs up a user and connects one repo, like the dashboard would.
const setUp = async (email = 'fox@example.com') => {
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').send({ email, password: 'hunter2!!' });
  const connect = await agent.post('/api/repos').send({ fullName: 'fox/den' });
  const repoId: number = connect.body.id;

  return {
    agent,
    repoId,
    secret: connect.body.webhookSecret as string,
    webhookUrl: `/api/webhooks/github/${repoId}`,
  };
};

// Signs a body the way GitHub does. Written out here, not imported from the server code,
// so the tests would catch a mistake in the server's own signing.
const githubSignature = (body: string, secret: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

// Sends a delivery the way GitHub does: no login cookie, a JSON body, a signature header.
const deliver = (
  url: string,
  body: string,
  signature?: string,
  { event = 'ping', deliveryId = crypto.randomUUID() as string } = {},
) => {
  const req = request(app)
    .post(url)
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', deliveryId);
  if (signature !== undefined) req.set('X-Hub-Signature-256', signature);
  return req.send(body);
};

// Sends a correctly signed delivery of one GitHub event type.
const deliverEvent = (
  repo: { webhookUrl: string; secret: string },
  event: string,
  payload: object,
  deliveryId?: string,
) => {
  const body = JSON.stringify(payload);
  return deliver(repo.webhookUrl, body, githubSignature(body, repo.secret), { event, deliveryId });
};

const savedEvents = async (repoId: number) => {
  const result = await pool.query(
    'SELECT type, details, github_delivery_id FROM events WHERE repo_id = $1 ORDER BY id',
    [repoId],
  );
  return result.rows;
};

const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 });

// Trimmed-down versions of GitHub's payloads, with a few fields we don't read left in.
const mergedPullRequest = {
  action: 'closed',
  number: 12,
  pull_request: {
    number: 12,
    title: 'add login route',
    html_url: 'https://github.com/fox/den/pull/12',
    merged: true,
    state: 'closed',
  },
  repository: { full_name: 'fox/den' },
};

const workflowRun = (conclusion: string | null, action = 'completed') => ({
  action,
  workflow_run: {
    name: 'CI',
    html_url: 'https://github.com/fox/den/actions/runs/99',
    conclusion,
    pull_requests: [{ number: 12 }],
  },
  repository: { full_name: 'fox/den' },
});

describe('POST /api/webhooks/github/:repoId', () => {
  it('accepts a delivery signed with the repo secret', async () => {
    const { webhookUrl, secret } = await setUp();

    const res = await deliver(webhookUrl, ping, githubSignature(ping, secret));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('rejects a delivery with no signature', async () => {
    const { webhookUrl } = await setUp();

    const res = await deliver(webhookUrl, ping);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  it('rejects a delivery signed with the wrong secret', async () => {
    const { webhookUrl } = await setUp();

    const res = await deliver(webhookUrl, ping, githubSignature(ping, 'not-the-secret'));

    expect(res.status).toBe(401);
  });

  it('rejects a body that was changed after it was signed', async () => {
    const { webhookUrl, secret } = await setUp();
    const tampered = JSON.stringify({ zen: 'Trust me.', hook_id: 1 });

    const res = await deliver(webhookUrl, tampered, githubSignature(ping, secret));

    expect(res.status).toBe(401);
  });

  it('checks the signature against the exact bytes sent, not re-serialized JSON', async () => {
    const { webhookUrl, secret } = await setUp();
    // Same data as `ping`, but with spacing that JSON.parse + JSON.stringify would lose.
    const spaced = '{ "zen" : "Keep it logically awesome.",\n  "hook_id" : 1 }';

    const res = await deliver(webhookUrl, spaced, githubSignature(spaced, secret));

    expect(res.status).toBe(200);
  });

  it("rejects a delivery signed with a different repo's secret", async () => {
    const mine = await setUp('mine@example.com');
    const theirs = await setUp('theirs@example.com');

    const res = await deliver(mine.webhookUrl, ping, githubSignature(ping, theirs.secret));

    expect(res.status).toBe(401);
  });

  it('stops accepting the old secret once a new one is generated', async () => {
    const { agent, repoId, webhookUrl, secret: oldSecret } = await setUp();
    const renewed = await agent.post(`/api/repos/${repoId}/webhook-secret`);
    const newSecret: string = renewed.body.webhookSecret;

    const withOld = await deliver(webhookUrl, ping, githubSignature(ping, oldSecret));
    const withNew = await deliver(webhookUrl, ping, githubSignature(ping, newSecret));

    expect(withOld.status).toBe(401);
    expect(withNew.status).toBe(200);
  });

  it.each([
    ['an ID no repo has', '999999'],
    ['an ID that is not a number', 'banana'],
    ['an ID too large to be real', '99999999999999999999'],
  ])('returns 404 for %s', async (_label, id) => {
    const res = await deliver(`/api/webhooks/github/${id}`, ping, githubSignature(ping, 'x'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Repo not found' });
  });

  it('leaves JSON parsing working for the other routes', async () => {
    const { agent } = await setUp();

    const res = await agent.post('/api/repos').send({ fullName: 'fox/second-den' });

    expect(res.status).toBe(201);
  });
});

describe('saving events', () => {
  it('saves a merged pull request with its number, title, and url', async () => {
    const repo = await setUp();

    const res = await deliverEvent(repo, 'pull_request', mergedPullRequest, 'delivery-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(await savedEvents(repo.repoId)).toEqual([
      {
        type: 'pr_merged',
        details: {
          number: 12,
          title: 'add login route',
          url: 'https://github.com/fox/den/pull/12',
        },
        github_delivery_id: 'delivery-1',
      },
    ]);
  });

  it('saves a passed workflow run with its name, url, and pull request number', async () => {
    const repo = await setUp();

    await deliverEvent(repo, 'workflow_run', workflowRun('success'));

    expect(await savedEvents(repo.repoId)).toMatchObject([
      {
        type: 'tests_passed',
        details: { name: 'CI', url: 'https://github.com/fox/den/actions/runs/99', number: 12 },
      },
    ]);
  });

  it('saves a failed workflow run', async () => {
    const repo = await setUp();

    await deliverEvent(repo, 'workflow_run', workflowRun('failure'));

    expect(await savedEvents(repo.repoId)).toMatchObject([{ type: 'tests_failed' }]);
  });

  it('leaves out the pull request number when the run was not for one', async () => {
    const repo = await setUp();
    const run = workflowRun('success');
    run.workflow_run.pull_requests = [];

    await deliverEvent(repo, 'workflow_run', run);

    const [event] = await savedEvents(repo.repoId);
    expect(event.details).toEqual({
      name: 'CI',
      url: 'https://github.com/fox/den/actions/runs/99',
    });
  });

  describe('which branch a workflow run was on', () => {
    // A run with the branch fields GitHub sends: the run's own branch and repo, and the
    // default branch of the repo the webhook belongs to.
    const runOnBranch = (headBranch: string, { headRepoId = 1, defaultBranch = 'main' } = {}) => ({
      ...workflowRun('failure'),
      workflow_run: {
        ...workflowRun('failure').workflow_run,
        head_branch: headBranch,
        head_repository: { id: headRepoId },
      },
      repository: { id: 1, full_name: 'fox/den', default_branch: defaultBranch },
    });

    const savedDetails = async (repoId: number) => (await savedEvents(repoId))[0].details;

    it('marks a run on the default branch', async () => {
      const repo = await setUp();

      await deliverEvent(repo, 'workflow_run', runOnBranch('main'));

      expect(await savedDetails(repo.repoId)).toMatchObject({ onDefaultBranch: true });
    });

    it('uses the default branch GitHub reports, whatever it is called', async () => {
      const repo = await setUp();

      await deliverEvent(repo, 'workflow_run', runOnBranch('trunk', { defaultBranch: 'trunk' }));

      expect(await savedDetails(repo.repoId)).toMatchObject({ onDefaultBranch: true });
    });

    it('still saves a run on another branch, marked as not on the default branch', async () => {
      const repo = await setUp();

      await deliverEvent(repo, 'workflow_run', runOnBranch('feature/login'));

      expect(await savedEvents(repo.repoId)).toMatchObject([
        { type: 'tests_failed', details: { onDefaultBranch: false } },
      ]);
    });

    it("does not count a fork's branch that shares the default branch's name", async () => {
      const repo = await setUp();

      await deliverEvent(repo, 'workflow_run', runOnBranch('main', { headRepoId: 2 }));

      expect(await savedDetails(repo.repoId)).toMatchObject({ onDefaultBranch: false });
    });

    it('makes the pet sick for a failure on the default branch only', async () => {
      const repo = await setUp();
      await repo.agent
        .post(`/api/repos/${repo.repoId}/pet`)
        .send({ name: 'Kitsu', character: 'kitsune' });
      const mood = async () => (await repo.agent.get(`/api/repos/${repo.repoId}/pet`)).body.mood;

      await deliverEvent(repo, 'workflow_run', runOnBranch('feature/login'));
      const afterBranchFailure = await mood();
      await deliverEvent(repo, 'workflow_run', runOnBranch('main'));
      const afterMainFailure = await mood();

      expect(afterBranchFailure).toBe('normal');
      expect(afterMainFailure).toBe('sick');
    });

    it('leaves the mark out when GitHub does not say which branch', async () => {
      const repo = await setUp();

      await deliverEvent(repo, 'workflow_run', workflowRun('failure'));

      expect(await savedDetails(repo.repoId)).not.toHaveProperty('onDefaultBranch');
    });
  });

  it.each([
    ['a ping', 'ping', { zen: 'Keep it logically awesome.' }],
    ['an opened pull request', 'pull_request', { ...mergedPullRequest, action: 'opened' }],
    [
      'a pull request closed without merging',
      'pull_request',
      { action: 'closed', pull_request: { ...mergedPullRequest.pull_request, merged: false } },
    ],
    ['a workflow run that only just started', 'workflow_run', workflowRun(null, 'requested')],
    ['a cancelled workflow run', 'workflow_run', workflowRun('cancelled')],
    ['an event type we do not track', 'issues', { action: 'opened' }],
    ['a pull_request delivery with an unexpected shape', 'pull_request', { action: 'closed' }],
    ['a body that is JSON but not an object', 'pull_request', ['closed']],
  ])('answers 200 but saves nothing for %s', async (_label, event, payload) => {
    const repo = await setUp();

    const res = await deliverEvent(repo, event, payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(await savedEvents(repo.repoId)).toEqual([]);
  });

  it('saves a repeated delivery only once, and still answers 200', async () => {
    const repo = await setUp();
    await deliverEvent(repo, 'pull_request', mergedPullRequest, 'same-delivery');

    const again = await deliverEvent(repo, 'pull_request', mergedPullRequest, 'same-delivery');

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true });
    expect(await savedEvents(repo.repoId)).toHaveLength(1);
  });

  it('saves the same delivery for every user who connected that repo', async () => {
    // Two people connect the same GitHub repo. GitHub sends each of their webhooks
    // the same event with the same delivery ID.
    const maia = await setUp('maia@example.com');
    const olivia = await setUp('olivia@example.com');

    await deliverEvent(maia, 'pull_request', mergedPullRequest, 'shared-delivery');
    await deliverEvent(olivia, 'pull_request', mergedPullRequest, 'shared-delivery');

    expect(await savedEvents(maia.repoId)).toHaveLength(1);
    expect(await savedEvents(olivia.repoId)).toHaveLength(1);
  });

  it('saves separate deliveries as separate events', async () => {
    const repo = await setUp();

    await deliverEvent(repo, 'pull_request', mergedPullRequest);
    await deliverEvent(repo, 'workflow_run', workflowRun('success'));

    const events = await savedEvents(repo.repoId);
    expect(events.map((event) => event.type)).toEqual(['pr_merged', 'tests_passed']);
  });

  it('saves the event against the repo in the URL only', async () => {
    const mine = await setUp('mine@example.com');
    const theirs = await setUp('theirs@example.com');

    await deliverEvent(mine, 'pull_request', mergedPullRequest);

    expect(await savedEvents(mine.repoId)).toHaveLength(1);
    expect(await savedEvents(theirs.repoId)).toEqual([]);
  });

  it('saves nothing when the signature is wrong', async () => {
    const repo = await setUp();
    const body = JSON.stringify(mergedPullRequest);

    const res = await deliver(repo.webhookUrl, body, githubSignature(body, 'not-the-secret'), {
      event: 'pull_request',
    });

    expect(res.status).toBe(401);
    expect(await savedEvents(repo.repoId)).toEqual([]);
  });

  it('rejects a signed body that is not JSON', async () => {
    const repo = await setUp();
    const body = 'payload=%7B%22action%22%3A%22closed%22%7D';

    const res = await deliver(repo.webhookUrl, body, githubSignature(body, repo.secret), {
      event: 'pull_request',
    });

    expect(res.status).toBe(400);
    expect(await savedEvents(repo.repoId)).toEqual([]);
  });

  it('rejects an event we would save if GitHub sent no delivery ID', async () => {
    const repo = await setUp();
    const body = JSON.stringify(mergedPullRequest);

    // Built by hand: the `deliver` helper always adds the X-GitHub-Delivery header.
    const res = await request(app)
      .post(repo.webhookUrl)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', githubSignature(body, repo.secret))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing X-GitHub-Delivery header' });
    expect(await savedEvents(repo.repoId)).toEqual([]);
  });

  it('accepts a delivery bigger than 100 KB', async () => {
    const repo = await setUp();
    // A pull request with a very long description, well over Express's default body limit.
    const body = JSON.stringify({
      action: 'closed',
      pull_request: { merged: true, number: 7, title: 'big one', body: 'x'.repeat(150_000) },
    });

    const res = await deliver(repo.webhookUrl, body, githubSignature(body, repo.secret), {
      event: 'pull_request',
    });

    expect(res.status).toBe(200);
    expect(await savedEvents(repo.repoId)).toHaveLength(1);
  });

  it('removes the events when the repo is disconnected', async () => {
    const repo = await setUp();
    await deliverEvent(repo, 'pull_request', mergedPullRequest);

    await repo.agent.delete(`/api/repos/${repo.repoId}`);

    expect(await savedEvents(repo.repoId)).toEqual([]);
  });
});

describe('signature helpers', () => {
  // The example from GitHub's "Validating webhook deliveries" docs.
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from('Hello, World!');
  const expected = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  it("produces the same signature as GitHub's documented example", () => {
    expect(signPayload(body, secret)).toBe(expected);
  });

  it('accepts the documented signature and rejects anything else', () => {
    expect(isValidSignature(body, secret, expected)).toBe(true);
    expect(isValidSignature(body, secret, expected.replace(/7$/, '8'))).toBe(false);
    expect(isValidSignature(body, secret, 'sha256=short')).toBe(false);
    expect(isValidSignature(body, secret, undefined)).toBe(false);
  });
});
