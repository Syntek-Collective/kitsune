# Security Policy

Kitsune stores account passwords and receives webhooks from GitHub, so we take security reports seriously. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

We'll acknowledge your report as soon as we can, keep you updated while we fix it, and credit you if you'd like.

## Supported versions

Only the latest release and the live site get security fixes.

## Scope

Things we especially want to hear about:

- One user being able to see, change, or delete another user's repos, pets, or events
- Forging a webhook: getting the server to accept an event without a valid signature
- Bypassing login on the API, or reusing someone else's token
- A webhook secret, password hash, or token leaking (into logs, error messages, URLs, or API responses)
- Ways to run code in another user's browser through the dashboard or the extension

Not in scope: bugs in third-party services themselves (GitHub, Render, Supabase). Report those to their vendors.

## How Kitsune protects data

A quick summary for reviewers. Details are in [docs/API.md](docs/API.md).

- **Passwords** are stored as bcrypt hashes and never returned by the API.
- **Logins** are JWTs. The dashboard gets one in an httpOnly cookie, the extension as a Bearer token. The server takes the user's identity from the token, never from the request body.
- **Ownership:** every repo, pet, and event route checks that the record belongs to the logged-in user.
- **Webhooks** are checked against each repo's own secret (`X-Hub-Signature-256`) before anything is saved.
- **Login attempts** are rate limited.
- **Database:** Row Level Security is turned on for every table, so the hosting provider's public API can't reach the data.

## For contributors

- Never commit `.env` files or real secrets. Use `.env.example` with placeholder values.
- Don't log passwords, tokens, webhook secrets, or full request bodies.
- Server tests refuse to run unless the database name ends in `_test`. Never point them at a real database.
