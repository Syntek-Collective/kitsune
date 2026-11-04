// Limits how often someone can try to log in or sign up, so a password can't be guessed
// by trying thousands of them. Counts are kept in memory: fine for one server process,
// and they reset when the server restarts.
import type { Request } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit } from 'express-rate-limit';

export const AUTH_RATE_LIMIT = 10;
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// The same JSON shape as every other error (docs/API.md, "Error format"). The dashboard shows it as-is.
const tooManyAttempts = { error: 'Too many attempts. Try again in 15 minutes' };

// ipKeyGenerator groups IPv6 addresses by network, so someone with a whole block of
// addresses can't get a fresh limit for each one.
const clientKey = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

// Emails are compared in lowercase in routes.ts, so "Fox@x.com" and "fox@x.com" share a count.
const loginKey = (req: Request): string => {
  const email: unknown = req.body?.email;
  const cleaned = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return `${clientKey(req)}:${cleaned}`;
};

// Each limiter needs its own store. Kept here so tests can start each one from zero.
const loginStore = new MemoryStore();
const signupStore = new MemoryStore();

const sharedOptions = {
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: AUTH_RATE_LIMIT,
  message: tooManyAttempts,
  // Sends RateLimit and Retry-After headers, so a client can tell when to try again.
  standardHeaders: 'draft-8',
  legacyHeaders: false,
} as const;

// Per IP address and email: one person guessing one account's password is stopped,
// without locking out everyone else who shares their network. A successful login
// doesn't count, so someone who logs in often is never blocked.
export const loginRateLimit = rateLimit({
  ...sharedOptions,
  store: loginStore,
  keyGenerator: loginKey,
  skipSuccessfulRequests: true,
});

// Per IP address: stops one client creating accounts in bulk, or using signup's
// "Email already registered" answer to check which emails have accounts.
export const signupRateLimit = rateLimit({
  ...sharedOptions,
  store: signupStore,
  keyGenerator: clientKey,
});

// For tests: forget every count, so each test starts with a full allowance.
export const resetAuthRateLimits = async (): Promise<void> => {
  await Promise.all([loginStore.resetAll(), signupStore.resetAll()]);
};
