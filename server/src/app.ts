// Express app: middleware and routes are added here. Kept separate from index.ts so tests can import the app. (CHA-7, CHA-9)
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRouter from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { requireRepoOwner } from './auth/ownership.js';
import eventsRouter from './events/routes.js';
import petRouter from './pets/routes.js';
import reposRouter from './repos/routes.js';
import { requestLogger } from './requestLogger.js';
import { parseTrustProxy } from './trustProxy.js';
import webhooksRouter from './webhooks/routes.js';

const app = express();

// Lets req.ip be the visitor's address rather than the hosting proxy's, so the login
// rate limit counts each visitor separately. See trustProxy.ts.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV));

// Webhook signatures are checked against the exact bytes GitHub sent, so these routes
// keep the body raw. This must come before express.json(), which then skips the request
// because its body has already been read.
// GitHub's deliveries can be bigger than Express's default limit of 100 KB
// (a pull request with a long description, for example), so allow up to 1 MB.
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json());
app.use(cookieParser());

// Log API requests only. The dashboard's pages and files would bury them, and test runs
// don't need a line per request.
if (process.env.NODE_ENV !== 'test') {
  app.use('/api', requestLogger);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.use('/api/auth', authRouter);

// Every pet and event route needs a logged-in user who owns the repo in the URL, so both
// checks run here, once, before the router sees the request.
app.use('/api/repos/:repoId/pet', requireAuth, requireRepoOwner, petRouter);
app.use('/api/repos/:repoId/events', requireAuth, requireRepoOwner, eventsRouter);

app.use('/api/repos', reposRouter);

// No requireAuth here: GitHub can't log in. Each delivery proves itself with a signature.
app.use('/api/webhooks', webhooksRouter);

// Unknown /api routes: answer in the contract's JSON error shape, not an HTML page.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// In production, Express also serves the built dashboard, so the dashboard and
// the API share one domain (which keeps the login cookie first-party).
// In local dev this folder doesn't exist, and Vite serves the dashboard instead.
const dashboardDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dashboard/dist',
);

if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));

  // Any other URL (like /login or /repos/11) gets index.html, and React Router
  // shows the right page. Without this, refreshing a page would be a 404.
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
}

// Global error handler. Express knows it's an error handler because it has 4 arguments,
// so `_next` has to stay even though it's unused. It must come after every route.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  // express.json() sets status 400 when the request body isn't valid JSON.
  if (err.status === 400) {
    res.status(400).json({ error: 'Request body must be valid JSON' });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

export default app;
