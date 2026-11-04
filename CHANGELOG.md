# Changelog

All notable changes to Kitsune are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-04

First public release under Syntek Collective.

### Added

- Dashboard: sign up, connect a GitHub repo, pick and name a pet, webhook setup, mood and event log.
- Chrome extension (Manifest V3): the fox sits on connected repos' GitHub pages, walks around, and speaks when pull requests merge or tests pass or fail.
- Server: Express and PostgreSQL API with JWT auth (httpOnly cookie for the dashboard, Bearer token for the extension), per-repo webhook secrets checked against GitHub's signature, and mood worked out from stored events.
- Rate limiting on log in (10 failed attempts per IP address and email per 15 minutes) and sign up (10 per IP address per 15 minutes), with a JSON `429` and `Retry-After` header.
- `TRUST_PROXY` setting so the server sees each visitor's real IP address behind the host's proxy.
- Project files: security policy with private vulnerability reporting, code of conduct, issue and pull request templates, Dependabot.

### Changed

- Only test runs on the repo's default branch affect the pet's mood. Runs on other branches and from forks are still saved and shown in the event log.
