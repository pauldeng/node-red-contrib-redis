# Main Migration and Publish Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the old upstream `master`, make `claude-review` the new `main`, and prepare `@pauldeng/node-red-contrib-redis@2.0.0` for a high-quality npm and Node-RED Library release.

**Architecture:** Treat branch migration, package identity, release hardening, verification, and publication as separate gates. Do not publish until branch history is protected, package metadata matches the repository/npm owner, docs match the shipped tarball, and all release checks are repeatable from a clean checkout.

**Tech Stack:** Node.js 24 working runtime, Node-RED 5.0.1 target, ioredis 5.11.1, npm package publishing, GitHub repository/default branch controls, Docker-managed Redis test matrix, Playwright editor tests.

## Global Constraints

- Preserve current `master` exactly as legacy upstream before moving default branch.
- Base new `main` on current `claude-review`.
- Do not overwrite uncommitted Cursor/Codex changes; commit or deliberately discard them before branch surgery.
- Publish as `@pauldeng/node-red-contrib-redis@2.0.0`; do not publish under the existing unscoped `node-red-contrib-redis` package.
- Keep `node-red` in `keywords` only after the node is stable and documented; this repo is close, but release checks must pass first.
- Use npm trusted publishing if the GitHub repository is public and package settings allow it; npm docs recommend trusted publishing over long-lived tokens.

---

## Current Findings

- Current branch is `claude-review`, ahead of `origin/claude-review` by 5 commits.
- Local uncommitted release-identity changes exist in `README.md`, `package.json`, `package-lock.json`, and this plan.
- `origin/master` and local `master` are both `5865f2d Update package.json`.
- No `.github/workflows` release or CI workflow exists.
- `npm view node-red-contrib-redis` shows public version `1.4.0`, maintained by `chameleonbr <chameleonbr@gmail.com>`.
- Package identity decision: publish the v2 line as `@pauldeng/node-red-contrib-redis`.
- `npm whoami` fails with `ENEEDAUTH` in this environment.
- `npm pack --dry-run` currently ships 19 files as `pauldeng-node-red-contrib-redis-2.0.0.tgz`: runtime/editor, icons, examples, README assets, README, LICENSE, package metadata, and CHANGELOG. It does not ship tests or agent docs.
- `npm audit --omit=dev` currently reports 0 vulnerabilities.
- Public README no longer contains the `Work with AI Agent` section.

## Task 1: Freeze Current Work Before Branch Surgery

**Files:**

- Review/commit current dirty files before branch operations.

**Interfaces:**

- Consumes: current `claude-review` worktree.
- Produces: a clean working tree on `claude-review`.

- [ ] **Step 1: Review the current diff**

Run:

```bash
git status --short --branch
git diff --stat
git diff -- redis.js redis.html test/scripting_commands_spec.js docs/NODE_GUIDE.md CHANGELOG.md
```

Expected: only intentional release-hardening changes are present.

- [ ] **Step 2: Run focused tests for the current dirty Lua changes**

Run with a standalone Redis available on `127.0.0.1:6379`, or use the Docker compose command in Step 3:

```bash
npm run test:mocha -- test/scripting_commands_spec.js --grep "SCRIPT LOAD compile|Keys=0|stored\\)|runs EVAL_RO|runs EVALSHA_RO|loads a library|runs FCALL_RO|reloads its library|function mode"
```

Expected: 14 passing.

- [ ] **Step 3: If Redis is not already running, run the focused test with temporary Docker Redis**

```bash
docker compose -p node-red-contrib-redis-review -f test/deployments/single-noauth/compose.yml up -d
node -e "const Redis=require('ioredis'); const c=new Redis({host:'127.0.0.1',port:6379}); c.ping().then(()=>c.disconnect()).catch(e=>{console.error(e); process.exit(1);})"
npm run test:mocha -- test/scripting_commands_spec.js --grep "SCRIPT LOAD compile|Keys=0|stored\\)|runs EVAL_RO|runs EVALSHA_RO|loads a library|runs FCALL_RO|reloads its library|function mode"
docker compose -p node-red-contrib-redis-review -f test/deployments/single-noauth/compose.yml down -v --remove-orphans
```

Expected: Redis starts, the focused test passes, and the deployment tears down.

- [ ] **Step 4: Commit the current intentional changes**

```bash
git add CHANGELOG.md docs/NODE_GUIDE.md docs/REDIS_8_8_HARDENING_REVIEW.md redis.html redis.js test/scripting_commands_spec.js
git commit -m "Fix Lua SCRIPT LOAD errors and Keys=0 payload shaping"
```

Expected: clean working tree on `claude-review`. If the commit already exists, confirm with `git status --short`.

## Task 2: Preserve Legacy Upstream Master

**Files:**

- Git refs only.

**Interfaces:**

- Consumes: clean local checkout with `master` at legacy upstream.
- Produces: pushed backup branch and tag for the old master.

- [ ] **Step 1: Fetch and confirm legacy master**

```bash
git fetch origin --prune
git rev-parse master
git rev-parse origin/master
git log --oneline -1 master
git log --oneline -1 origin/master
```

Expected: both local and remote `master` resolve to `5865f2d` unless upstream changed since this plan was written.

- [ ] **Step 2: Create immutable-looking backup refs**

```bash
git branch legacy-upstream-master master
git tag legacy-upstream-master-2026-07-26 master
```

Expected: local branch and tag point to old `master`.

- [ ] **Step 3: Push backup refs**

```bash
git push origin legacy-upstream-master
git push origin legacy-upstream-master-2026-07-26
```

Expected: remote has a branch and tag preserving the old upstream state.

- [ ] **Step 4: Protect the backup branch in GitHub**

Use GitHub UI or CLI:

```bash
gh api repos/pauldeng/node-red-contrib-redis/branches/legacy-upstream-master/protection \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field enforce_admins=true \
  --field restrictions=null
```

Expected: accidental pushes/deletes to `legacy-upstream-master` are blocked. If `gh` is not authenticated, do this in the GitHub branch protection UI.

## Task 3: Create `main` From `claude-review`

**Files:**

- Git refs and GitHub repository default branch setting.

**Interfaces:**

- Consumes: clean `claude-review`, backed-up `master`.
- Produces: remote `main` based on `claude-review`.

- [ ] **Step 1: Create/reset local `main` from `claude-review`**

```bash
git switch claude-review
git status --short
git branch -f main claude-review
git switch main
```

Expected: `main` points at the same commit as `claude-review`.

- [ ] **Step 2: Push `main`**

```bash
git push -u origin main
```

Expected: remote `origin/main` exists.

- [ ] **Step 3: Change GitHub default branch**

Preferred with GitHub CLI:

```bash
gh repo edit pauldeng/node-red-contrib-redis --default-branch main
```

Fallback: GitHub repository Settings → Branches → Default branch → switch to `main`.

Expected: `origin/HEAD` points to `origin/main` after `git remote set-head origin -a`.

- [ ] **Step 4: Decide whether to keep `master`**

Do not delete `master` immediately. Keep it for one release cycle as a compatibility pointer. After the first stable `main` release, decide whether to lock it, rename it, or leave it as historical upstream.

## Task 4: Set Scoped Package Identity Before Publishing

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: badge URLs in `README.md`

**Interfaces:**

- Consumes: confirmed scoped package decision.
- Produces: package metadata that can be published legally and discovered correctly.

- [ ] **Step 1: Verify npm access**

```bash
npm whoami
npm view @pauldeng/node-red-contrib-redis version --json
```

Expected: npm login works. The scoped package is either unpublished or reports a version lower than `2.0.0`.

- [x] **Step 2: Set the scoped package identity**

```json
"name": "@pauldeng/node-red-contrib-redis",
"version": "2.0.0",
"publishConfig": {
  "access": "public"
}
```

Expected: the package can be published publicly under the `@pauldeng` scope.

- [x] **Step 3: Update repository metadata**

For this repository, use:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/pauldeng/node-red-contrib-redis.git"
},
"bugs": {
  "url": "https://github.com/pauldeng/node-red-contrib-redis/issues"
},
"homepage": "https://github.com/pauldeng/node-red-contrib-redis#readme"
```

Expected: `package.json` matches the actual GitHub repository. This is also required for npm trusted publishing to line up cleanly with GitHub repository identity.

- [x] **Step 4: Fix public metadata quality**

Update `package.json`:

```json
"description": "Redis integration nodes for Node-RED with Cluster, Sentinel, streams, pub/sub, commands, Lua, and Redis Functions."
```

Review `author`/`maintainers` honestly:

- preserve original author if this is a continuation/fork;
- add current maintainer if you will support the release;
- do not claim old maintainer contact as the only active maintainer if publishing from `pauldeng`.

- [x] **Step 5: Regenerate lockfile after package name/metadata changes**

```bash
npm install --package-lock-only
```

Expected: package name/version metadata in `package-lock.json` matches `package.json`.

## Task 5: Clean Public README for Node-RED Library

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: final package name and support policy.
- Produces: README suitable for npm and flows.nodered.org.

- [x] **Step 1: Remove the AI-agent section**

Delete the entire `## Work with AI Agent` section:

```markdown
## Work with AI Agent

1. Support Claude and Codex
2. Install [superpowers plugin](https://github.com/obra/superpowers)
3. Install [codegraph](https://github.com/colbymchenry/codegraph)
4. Enjoy
```

Expected: README is user-facing, not maintainer-agent-facing.

- [ ] **Step 2: Add a compatibility matrix**

Insert under `## Install`:

```markdown
## Compatibility

| Package                  | Supported                                                    |
| ------------------------ | ------------------------------------------------------------ |
| Node.js                  | >= 22.9                                                      |
| Node-RED                 | >= 5.0.0                                                     |
| Redis client             | ioredis 5.x                                                  |
| Redis deployments tested | Standalone, ACL auth, Cluster, Sentinel, AWS MemoryDB opt-in |
```

Expected: users see compatibility before installing.

- [ ] **Step 3: Add upgrade note from 1.4.0**

Insert near the changelog link or Quickstart:

```markdown
## Upgrading From 1.4.0

Version 2.0.0 raises the runtime floor to Node-RED 5 and Node.js 22.9, fixes several previously silent error paths, and changes some edge-case argument handling. Read [CHANGELOG.md](CHANGELOG.md) before upgrading production flows.
```

Expected: breaking changes are visible on npm and Node-RED Library.

- [ ] **Step 4: Add security note for connection URLs**

Add under Configuration Notes:

```markdown
Prefer JSON object options or encrypted credentials for passwords. A password embedded in a `redis://user:pass@host` URL can appear in verbose connection-test diagnostics; object-form passwords are redacted.
```

Expected: public README matches current known issue in `CHANGELOG.md`.

## Task 6: Fix the Known Credential-URL Redaction Issue Before Release

**Files:**

- Modify: `redis.js`
- Test: `test/redis_status_spec.js` or `test/redis_credentials_spec.js`

**Interfaces:**

- Consumes: `redactValue`, `serializeError`, `/redis-config/test` endpoint.
- Produces: no credential leaks from connection-test error payloads/logs for Redis URLs.

- [ ] **Step 1: Add a failing test**

Add a test that posts options containing a Redis URL with credentials to `/redis-config/test` and asserts the password is absent from:

- HTTP response body;
- logged `node.error` payload where test helper exposes it.

Use a URL like:

```text
redis://user:super-secret-pass@127.0.0.1:6399
```

Expected before fix: test fails because `super-secret-pass` appears.

- [ ] **Step 2: Implement URL redaction in `redactValue`**

Add URL-aware redaction for strings:

```js
if (typeof value === "string") {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "[redacted]";
      return url.toString();
    }
  } catch (_) {}
  return value;
}
```

Expected: object passwords and URL passwords are both redacted.

- [ ] **Step 3: Run focused test**

```bash
npm run test:mocha -- test/redis_status_spec.js --grep "connection test"
```

Expected: connection-test tests pass and no URL password appears.

## Task 7: Add CI Workflows Before Publishing

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: npm scripts and Docker test matrix.
- Produces: required checks for branch protection and a controlled publish path.

- [ ] **Step 1: Add CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  static-and-unit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npx prettier --check .
      - run: npm audit --omit=dev
      - run: npm run test:mocha -- test/redis_lua_ui_spec.js test/redis_credentials_spec.js

  docker-matrix:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm test

  editor:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:playwright
```

Expected: every PR and push to `main` runs static/unit, Docker matrix, and browser editor checks.

- [ ] **Step 2: Add release workflow skeleton**

Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version to publish, e.g. 2.0.0"
        required: true

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-24.04
    environment: npm
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          cache: npm
      - run: npm ci
      - run: test "$(node -p "require('./package.json').version")" = "${{ inputs.version }}"
      - run: npx prettier --check .
      - run: npm audit --omit=dev
      - run: npm test
      - run: npm run test:playwright
      - run: npm pack --dry-run
      - run: npm publish
```

Expected: workflow is ready for npm trusted publishing after configuring npm package trusted publisher settings.

- [ ] **Step 3: Configure GitHub branch protection**

Require:

- `static-and-unit`;
- `docker-matrix`;
- `editor`;
- PR review before merge;
- no direct pushes to `main` except release admin if desired.

Expected: default branch cannot drift without checks.

## Task 8: Full Release Verification

**Files:**

- No source changes unless failures require fixes.

**Interfaces:**

- Consumes: clean `main`.
- Produces: recorded release evidence.

- [ ] **Step 1: Clean checkout sanity**

```bash
git status --short --branch
npm ci
```

Expected: clean tree after `npm ci`.

- [ ] **Step 2: Formatting**

```bash
npx prettier --check .
```

Expected: all files pass.

- [ ] **Step 3: Production audit**

```bash
npm audit --omit=dev
```

Expected: 0 vulnerabilities.

- [ ] **Step 4: Full Docker matrix**

```bash
npm test
```

Expected: standalone no-auth/auth, cluster-auth, sentinel-auth pass; MemoryDB skips unless `MEMORYDB_ENABLED=1`.

- [ ] **Step 5: Browser editor suite**

```bash
npm run test:playwright
```

Expected: all editor tests pass.

- [ ] **Step 6: Pack inspection**

```bash
npm pack --dry-run
```

Expected: tarball includes only intended runtime/editor assets, examples, README assets, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`; no `test/`, `.claude/`, `.codex/`, `.github/`, deployment files, credentials, or local reports.

## Task 9: Clean Install Test in a Real Node-RED User Directory

**Files:**

- Temporary directory only.

**Interfaces:**

- Consumes: packed package.
- Produces: proof that Node-RED can install and register the package from the tarball shape.

- [ ] **Step 1: Build real tarball**

```bash
npm pack
```

Expected: one `.tgz` file for the final version.

- [ ] **Step 2: Install into a temporary Node-RED user directory**

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install node-red@5.0.1 /home/pdeng/Workspace/node-red-contrib-redis/pauldeng-node-red-contrib-redis-2.0.0.tgz
node -e "const pkg=require('./node_modules/@pauldeng/node-red-contrib-redis/package.json'); console.log(pkg['node-red'].nodes.redis)"
```

Expected: prints `redis.js`.

- [ ] **Step 3: Start Node-RED briefly and check registration**

```bash
npx node-red --userDir "$tmpdir" --safe --settings /home/pdeng/Workspace/node-red-contrib-redis/test/playwright/helpers/settings.js
```

Expected: Node-RED starts without module load errors. Stop it after registration is confirmed.

## Task 10: Publish to npm and Node-RED Library

**Files:**

- Git tags and npm registry state.

**Interfaces:**

- Consumes: all prior tasks complete.
- Produces: public npm package visible to Node-RED Library.

- [ ] **Step 1: Configure npm publishing**

If using trusted publishing:

- npm package Settings → Trusted Publisher → GitHub Actions;
- repository: `pauldeng/node-red-contrib-redis`;
- workflow: `release.yml`;
- after successful setup, use npm package Settings → Publishing access → require 2FA and disallow tokens.

If using interactive publish:

```bash
npm login
npm whoami
```

Expected: authenticated npm user has publish rights.

- [ ] **Step 2: Final version commit and tag**

```bash
git switch main
git status --short
git tag v2.0.0
git push origin main
git push origin v2.0.0
```

Expected: release tag points at the verified commit.

- [ ] **Step 3: Publish**

Trusted publishing:

```bash
gh workflow run release.yml -f version=2.0.0
```

Interactive:

```bash
npm publish
```

For a scoped first publish, ensure:

```json
"publishConfig": {
  "access": "public"
}
```

Expected: `npm view @pauldeng/node-red-contrib-redis version` returns `2.0.0`.

- [ ] **Step 4: Node-RED Library visibility**

Confirm package has:

- `node-red` keyword;
- valid `node-red.nodes` entry;
- README and package metadata on npm.

Then check:

```bash
npm view @pauldeng/node-red-contrib-redis keywords node-red version repository.url
```

Expected: Node-RED Library can index it from npm. If it does not appear quickly, sign in to flows.nodered.org with GitHub and verify the package page/indexing state.

## Task 11: Post-Release Operations

**Files:**

- GitHub release notes.
- Optional docs update if release evidence changes.

**Interfaces:**

- Consumes: npm package published.
- Produces: supportable public release.

- [ ] **Step 1: Create GitHub release**

Use `CHANGELOG.md` 2.0.0 section as release notes.

Expected: GitHub release `v2.0.0` links to npm package.

- [ ] **Step 2: Install from npm in a clean Node-RED**

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install node-red@5.0.1 @pauldeng/node-red-contrib-redis
node -e "console.log(require('./node_modules/@pauldeng/node-red-contrib-redis/package.json').version)"
```

Expected: prints `2.0.0`.

- [ ] **Step 3: Monitor initial issues**

Watch:

- npm package page;
- Node-RED Library page;
- GitHub issues;
- Node-RED forum if announced.

Expected: no immediate install/registration failures.

## Source Notes

- Node-RED official packaging docs require a `node-red` package entry, recommend `node-red` keyword for discoverability once stable, require dependencies in `dependencies`, and recommend README/license/examples at package root: https://nodered.org/docs/creating-nodes/packaging
- Node-RED official packaging docs state packages first published after 2022 should use scoped names, and forks can keep the same name under their own scope as a last-resort fork path: https://nodered.org/docs/creating-nodes/packaging
- npm docs require 2FA or a granular token with bypass 2FA for publishing, and recommend trusted publishing for CI/CD: https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/
- npm trusted publishing docs recommend OIDC trusted publishing over long-lived tokens and note `repository.url` must exactly match the GitHub repository for GitHub trusted publishing: https://docs.npmjs.com/trusted-publishers/
