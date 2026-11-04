// Types shared by the server, dashboard, and extension.
// They mirror docs/API.md, so if a response shape changes, TypeScript points to every place that uses it.

export type Mood = 'happy' | 'normal' | 'sick';

export type Character = 'kitsune';

export type EventType = 'pr_merged' | 'tests_passed' | 'tests_failed';

export type User = { id: number; email: string };

/** What a repo card needs to show a pet. `mood` is calculated, never stored. */
export type PetSummary = { name: string; character: Character; mood: Mood };

/** One item from GET /api/repos. */
export type Repo = {
  id: number;
  fullName: string;
  hasPet: boolean;
  pet: PetSummary | null;
  createdAt: string;
};

/** GET, POST, and PATCH /api/repos/:repoId/pet all return this. */
export type Pet = {
  id: number;
  name: string;
  character: Character;
  mood: Mood;
  createdAt: string;
  updatedAt: string;
};

/** One item from GET /api/repos/:repoId/events. `details` depends on the event type. */
export type RepoEvent = {
  id: number;
  type: EventType;
  details: {
    number?: number;
    title?: string;
    name?: string;
    url?: string;
    /** Test runs only: false when the run wasn't on the repo's default branch. */
    onDefaultBranch?: boolean;
  };
  createdAt: string;
};

/** POST /api/repos/:repoId/webhook-secret. */
export type WebhookDetails = { webhookUrl: string; webhookSecret: string };

/** POST /api/repos. The only time the secret comes back besides a new-secret request. */
export type ConnectedRepo = WebhookDetails & { id: number; fullName: string; createdAt: string };

export * from './events.js';
