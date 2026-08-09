# Change Workflow

Use this workflow for safe changes in current branch.

## Core principle

Minimize change surface.
In this repository, reliability comes from preserving existing Node-RED and ioredis behavior while changing only the narrow path needed for the task.

## Standard workflow

### Understand the request

Identify:

- affected node type
- runtime behavior
- editor behavior
- expected message contract
- shutdown/status implications

### Read before editing

Always read:

- the exact node constructor in `../redis.js`
- the exact editor definition in `../redis.html`
- the matching spec file

### Write the test first when possible

Prefer a regression-style test that:

- fails before the change
- passes after the change
- isolates one behavior

### Implement the minimum fix

Prefer:

- a narrow branch in existing logic
- a local helper
- keeping existing field names
- existing serialization patterns

Avoid:

- unrelated cleanup
- file splits
- style-only edits
- renaming ids or properties

### Update user-facing documentation

If behavior changes:

- update help text in `../redis.html`
- update examples when useful
- update the relevant note in `docs/`

### Verify

Run:

```bash
npm test
```

`npm test` manages the Docker deployment matrix itself. Run a targeted spec first with
`npm run test:node -- <spec>` only when you have already started a compatible Redis
deployment yourself. Husky also runs `npm test` on pre-commit, so a failing deployment
matrix or unavailable Docker will block your commit.

## Branches

`main` is the default branch and the only one that ships. Base work on `main` and merge back
into `main`.

### Upstream

This package is a fork of `chameleonbr/node-red-contrib-redis`, which is still active and
still uses `master` as its default branch. Track it with an `upstream` remote:

```bash
git remote add upstream https://github.com/chameleonbr/node-red-contrib-redis.git
git fetch upstream
git log --oneline upstream/master ^legacy-upstream-master   # what upstream has that we don't
```

The local `legacy-upstream-master` branch is configured to follow it — `branch.*.remote` is
`upstream`, `branch.*.merge` is `refs/heads/master`, and `branch.*.pushRemote` is `origin` — so
a fetch pulls from the original project while a push would target our fork.

Adding that remote changes what `gh` considers the base repository: with an `upstream` remote
present it targets the fork parent, so `gh pr create` fails against `chameleonbr` with
`No commits between ...` / `Base ref must be a branch`. Fix it once with
`gh repo set-default pauldeng/node-red-contrib-redis`, or pass
`--repo pauldeng/node-red-contrib-redis` per command.

`origin/legacy-upstream-master` is deliberately frozen at `5865f2d`, the tip of the deleted
`master`. It is a protected branch requiring an approving review, and with a single
collaborator no self-approval is possible, so it cannot be fast-forwarded. That is fine: its
job is preserving the pre-fork snapshot, and current upstream work is reachable through the
`upstream` remote instead. Read upstream changes there and port them deliberately — never
merge `upstream/master` into `main`, since the two trees diverged substantially (different
tests, docs, packaging, and Node-RED/Node floors).

### Never recreate `master`

This is load-bearing, not housekeeping. `master` held the abandoned pre-fork upstream tree
(v1.x: no `docs/`, no `examples/`, no test suite) and was deleted; that history is preserved
at `legacy-upstream-master` and at `origin/legacy-upstream-master`. Never merge from it,
cherry-pick from it, or treat it as current.

The reason a new `master` must never exist: the Node-RED flow library
(`node-red/flow-library`, `routes/nodes.js`) rewrites relative `<img src>` and `<a href>`
values in a package README against a **hardcoded** `master` branch — it never asks GitHub for
the repository's real default branch. npm's renderer uses `HEAD`, which resolves to `main`.
That is why the README screenshots once rendered on npmjs.com and 404'd on flows.nodered.org:
the rewritten `master` URLs landed in the v1.x tree, which has no `docs/assets/`.

With `master` deleted, GitHub's legacy default-branch redirect for this repo resolves `master`
to `main`, so the flow library's rewritten URLs now hit current content and `README.md` can
keep using ordinary relative paths. Verified: `raw/master/...` and `raw/main/...` return
byte-identical content, while a genuinely unknown ref 404s. Recreating a `master` branch would
shadow that redirect and silently break every relative README link on flows.nodered.org —
a surface invisible from a local checkout, from GitHub's own README view, and from npmjs.com.

Two consequences worth knowing:

- A README-only fix is not visible on flows.nodered.org until the next publish; the library
  re-reads the README per released version.
- The rewrite maps `.md` links to `blob/master/` and everything else to `raw/master/`, and
  raw cannot serve a directory listing. So a relative link to a directory (for example
  `[examples/](examples/)`) 404s on flows.nodered.org. Link to a file, or make that one link
  absolute to `https://github.com/pauldeng/node-red-contrib-redis/tree/main/examples`.

The flow library only re-reads the README when a new version is published, so a README-only
fix is not visible on flows.nodered.org until the next release.

## Releasing

Publishing runs only in GitHub Actions, over npm trusted publishing (OIDC). There is no npm
token in the repo or in Actions secrets, and no maintainer publishes from a workstation.

One-time setup on npmjs.com (package → Settings → Trusted publishers → GitHub Actions):

| Field             | Value                    |
| ----------------- | ------------------------ |
| Organization/user | `pauldeng`               |
| Repository        | `node-red-contrib-redis` |
| Workflow filename | `release.yml`            |
| Environment       | leave empty              |

Renaming `.github/workflows/release.yml` invalidates that config — update npmjs.com in the
same change.

Per release:

1. Bump `version` in `package.json` and move the `CHANGELOG.md` unreleased entries under it.
2. Merge to `main`.
3. Create a GitHub Release tagged `v<version>` (the tag must match `package.json`, or the
   workflow fails before publishing).

`Release` then re-runs the full gate — Prettier, `npm audit --omit=dev`, `npm test`, the
Playwright editor tests, `npm pack --dry-run` — and publishes with provenance. Confirm the
result with `npm view @pauldeng/node-red-contrib-redis@<version> dist`: a CI publish has an
`attestations` field, a workstation publish does not.

## Definition of Done

A change is complete only when runtime, editor, help text, tests, examples, **and docs** agree.
Docs are living maintenance artifacts: when features are added, behavior changes, tests move,
or examples drift, update the relevant project docs in the same change.

Before you consider the task finished, confirm you updated everything the change touched:

- changed a node's runtime behavior → update its section in `NODE_GUIDE.md`
- changed a connection-id, refcount, or shutdown path → update `ARCHITECTURE.md` and the
  Connection-id quick reference in `REFERENCE_MAP.md`
- changed user-visible behavior → update the `data-help-name` help block in `../redis.html`
- added, renamed, or removed a test file → update the spec list in `REFERENCE_MAP.md`,
  `TESTING.md`, and the skill file
- added a node type or a `defaults` field → update the source map in `../CLAUDE.md` and
  the public `../README.md`
- made a pattern easier to discover → add or update an example flow under `../examples/`

If you are unsure whether a doc is affected, grep the docs for the symbol or node type you
changed and check each hit.

## Worked example

A good template to imitate: commit `c8625d0` "Fall back to EVAL on NOSCRIPT for stored Lua
scripts."

1. Symptom: a stored Lua script fails with `NOSCRIPT` after Redis restarts or flushes its
   script cache, because the cached SHA1 is gone.
2. Locate: `RedisLua` input handler in `../redis.js`; matching coverage in
   `../test/scripting_commands_spec.js` and `../test/redis_status_spec.js`.
3. Narrow change: in the stored-script branch of the input handler, catch the `EVALSHA`
   rejection, detect the `NOSCRIPT` error prefix, and fall back to the matching `EVAL`
   variant, which resends the body and re-caches it under the same SHA1 (today this is the
   `try`/`catch` around `client[evalshaCmd](...)` in `RedisLua`). No new fields, no
   connection changes.
4. Verify: targeted scripting spec, then `npm test`; confirm status/shutdown unaffected.

Notice what it did **not** do: no refactor of the connection logic, no renamed fields, no
unrelated cleanup. That is the bar for every change here.
