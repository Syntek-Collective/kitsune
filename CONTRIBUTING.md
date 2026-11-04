# Contributing

How we work together on Kitsune Repo Pet.

## The golden rule

**Never push straight to `main`.** It's protected: every change goes through a pull request and needs 1 approval.

## Workflow

1. **Start from an up-to-date `main`:**

   ```bash
   git checkout main
   git pull
   ```

2. **Make a branch** named after what it does (`feat/`, `fix/`, `docs/`, `chore/`):

   ```bash
   git checkout -b feat/signup-routes
   ```

3. **Commit as you go** (see commit style below).

4. **Before opening a PR**, make sure these pass:

   ```bash
   npm run format
   npm run lint
   npm run typecheck
   ```

5. **Push your branch:**

   ```bash
   git push -u origin feat/signup-routes
   ```

6. **Open a pull request** into `main` on GitHub and request a reviewer.

7. **The reviewer merges it** after approving, then deletes the branch.

## Branch names

| Type       | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                        |
| `docs`     | Documentation only                               |
| `style`    | Formatting only, no code changes                 |
| `refactor` | Code changes that don't add features or fix bugs |
| `test`     | Adding or updating tests                         |
| `chore`    | Setup, config, dependencies                      |

`<type>/<short-description>`, all lowercase with dash or /.

Examples: `feat/signup-routes`, `feat/extension-pet-display, chore/dashboard-package`

## Commit messages

```
type(scope): short description
```

| Type       | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                        |
| `docs`     | Documentation only                               |
| `style`    | Formatting only, no code changes                 |
| `refactor` | Code changes that don't add features or fix bugs |
| `test`     | Adding or updating tests                         |
| `chore`    | Setup, config, dependencies                      |

The scope is optional and names the area: `feat(auth): add login route`, `docs(api.md): add error format`.

## Pull requests

- **Keep them small:** one issue per PR when possible. Small PRs get reviewed faster and cause fewer merge conflicts.
- **Title:** what it does plus the issue, e.g. `feat(auth): add signup and login routes (CHA-10)`.
- **Description:** what changed, how to test it, and anything the reviewer should look at closely.
- **Reviewing:** check that it matches [docs/API.md](docs/API.md), that it runs, and ask about anything unclear. Questions are good reviews.

## Updating your branch with new changes from `main`

If `main` changed while you were working:

```bash
git checkout main
git pull
git checkout your-branch-name
git merge main
```

Fix any conflicts, commit, and push.

## Secrets

- **Never commit `.env`.** Only `.env.example` is committed.
- If a secret ever gets pushed, tell the team and change it right away. Deleting the commit isn't enough.

## Adding a library

Install it in the package that uses it, not the root:

```bash
npm install some-library --workspace server
```

The root `package.json` only holds tools everyone uses (TypeScript, ESLint, Prettier).
