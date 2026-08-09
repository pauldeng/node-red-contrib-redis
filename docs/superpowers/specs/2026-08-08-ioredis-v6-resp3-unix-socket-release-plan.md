# Plan: ioredis 6, RESP3, Redis 8.10, Unix sockets, and trusted publishing

Date: 2026-08-08
Status: in progress — Steps 1-11 (renumbered below) implemented and committed
Target release: 3.0.0

## Amendment — 2026-08-08: latest-only Step 10 matrix

This amendment supersedes the minimum-version commitments in the original summary and Steps
6, 9, 10, 11, 12, and the final acceptance gate. Do not add `test:compat`, Redis 6.2, or
Valkey 7.2 jobs. RESP3's server floor is useful technical context, but it is not a tested or
documented support-floor promise for this release.

Step 10 targets Redis `latest`, Valkey `latest`, and optional AWS MemoryDB. Keep Redis 8.10
feature coverage capability-gated so it remains valid as the moving `latest` tag advances.
The release log must identify the resolved engine and version; it must not claim that a
floating tag certifies one exact version.

Use this lean matrix:

| Deployment                          | Coverage                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Redis latest, standalone no-auth    | Full standalone runtime and command suite                                            |
| Redis latest, standalone ACL auth   | Focused credential, connection/status, and authenticated command contract only       |
| Redis latest, Cluster and Sentinel  | Existing topology suites                                                             |
| Valkey latest, standalone no-auth   | Full standalone runtime and command suite, with capability-gated Redis-only features |
| Valkey latest, standalone ACL auth  | Focused credential, connection/status, and authenticated command contract only       |
| Valkey latest, Cluster and Sentinel | Existing topology suites                                                             |
| Redis latest, Unix socket           | Focused connection-test and runtime round-trip suite                                 |
| AWS MemoryDB                        | Existing opt-in suite only when explicitly enabled                                   |

Do not run the complete standalone suite again merely because authentication is enabled;
authentication changes connection establishment, not every command's dispatch or reply
mapping. The no-auth runs provide the complete engine coverage, while focused auth suites and
the authenticated Cluster/Sentinel suites protect the distinct credential paths.

Before implementing further test infrastructure, measure per-deployment and per-spec timing.
Apply these optimizations in order:

1. Pull each unique `latest` image once at the beginning of a test command and reuse that
   resolved local image for all services in that run. Avoid `pull_policy: always` on every
   service, which repeats registry checks and can resolve a moving tag inconsistently within
   one matrix run.
2. Replace fixed producer delays with observable readiness: wait for `PUBSUB NUMSUB`/`NUMPAT`
   before publishing, and for the matching blocked command in `CLIENT LIST` before pushing
   data or testing shutdown. Retain timeout timers only as failure bounds.
3. Merge editor checks that exercise the same dialog lifecycle when doing so preserves clear
   assertions—for example, test Unix-socket credential separation in the existing credential
   persistence scenario instead of starting a separate Node-RED process.
4. Keep readiness polling for Docker, Cluster, Sentinel, and Unix sockets. Those loops already
   test observable server state; their short sleeps are polling intervals, not completion
   assumptions. Do not replace them with longer fixed sleeps.

Do not parallelize topology deployments merely to reduce wall time: their fixed host ports
collide, and dynamic port orchestration would add more complexity than this matrix warrants.
Reconsider parallelism only if timing data shows topology startup remains the dominant cost
after the duplicate standalone runs and image pulls are removed.

Baseline measured on 2026-08-08 with Redis 8.10.0 and Valkey 9.1.1:

- `npm test`: 148.88 seconds.
- Each full Redis standalone pass: about 21 seconds.
- Each full Valkey standalone pass: about 18 seconds, including 67 capability skips.
- `npm run test:playwright`: 104.05 seconds; the separate Unix-socket credential scenario
  alone takes 9.2 seconds and can be folded into the existing credential-persistence test.

The implementation review must be closed before Step 10 is complete:

- Replace the full-suite `single-auth` and `valkey-auth` runs with the focused auth contract
  described above.
- Assert the expected engine identity for every Redis/Valkey deployment and log the resolved
  version for standalone, Cluster, Sentinel, and Unix-socket stages. Logging only the four
  standalone versions is insufficient to prove the matrix used the intended images.
- Update `docs/TESTING.md` after the runner is optimized, and remove the stale pinned-8.10
  assertion from `docs/TROUBLESHOOTING.md`.
- In Step 11, update the shared agent guide's stale ioredis 5.11.1 statement while making
  `AGENTS.md` canonical and `CLAUDE.md` import it.

Implementation follow-up measured on 2026-08-08:

- The focused authenticated profile, one-pull-per-image preparation, engine assertions,
  observable blocking/pub-sub waits, and the merged editor credential scenario are implemented.
- `npm test`: 88.42 seconds, all enabled deployments passing (MemoryDB remained opt-in).
- `npm run test:playwright`: 97.49 seconds, 10 passed and the one optional MemoryDB test skipped.
- The remaining 25 ms waits in readiness helpers are bounded polling intervals. Remaining
  fixed delays in older `redis-out` write assertions are candidates for a separate narrow
  refactor to poll the written key; they are not used as deployment readiness proof.

## Amendment — 2026-08-09: step renumbering, auth-coverage correction, test-runner migration

This amendment supersedes parts of the 2026-08-08 amendment above and of Steps 10-12 below.
It does not rewrite that history; it records what changed during implementation and why, so a
future reader isn't misled by superseded guidance left in place.

**Step renumbering.** The user asked mid-implementation to insert a new step for the test
runner migration (below), sequenced after compatibility coverage and before documentation.
The step numbers used in this document's original body (Steps 1-12) no longer match what was
actually executed. Read the original step numbers by name, not by number:

| Original step (this document)                         | Actually executed as                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Steps 1-9 (baseline through bundled-module coverage)  | Steps 1-9, unchanged                                  |
| Step 10 (compatibility and changed-behavior coverage) | Step 10, unchanged                                    |
| _(not in the original plan)_                          | **Step 11: migrate test runner, Mocha → `node:test`** |
| Step 11 (update documentation and agent guidance)     | Step 12                                               |
| Step 12 (preserve and extend release publishing)      | Step 13                                               |

**Auth-coverage correction.** The 2026-08-08 amendment's lean matrix specified a "focused"
`single-auth`/`valkey-auth` profile (credential, connection/status, and authenticated command
contract only), and its accompanying "Implementation follow-up" note recorded that profile as
implemented. It was: a version of the runner narrowed those two deployments to a ~50-test
subset. This was reverted before Step 10's commit, on explicit instruction to verify that
speed optimizations did not reduce the quality-control gate. The narrowing cut roughly 750
test executions from the matrix and removed a deliberate regression guard: every command-family
spec re-running under both no-auth and auth to catch connection-keying and credential-merge
bugs that only manifest when a config carries auth options, across the whole command surface,
not just auth-specific tests. **The shipped behavior re-runs the full standalone spec suite for
`single-auth` and `valkey-auth`, unchanged from `single-noauth`/`valkey-noauth` except for
credentials.** Do not re-introduce the focused-auth-subset narrowing described in the lean
matrix or the "do not run the complete standalone suite again merely because authentication is
enabled" paragraph above — both are superseded by this correction.

**Step 11: migrate test runner, Mocha → `node:test`.** Not anticipated by the original plan or
its Dependency update table (which still lists a `mocha 11.7.6 -> 11.8.0` bump). Mid-
implementation the user asked to replace Mocha with Node's built-in test runner, keeping
`node-red-node-test-helper` (Node-RED-specific flow-loading infrastructure with no native
replacement). All 26 spec files were ported. Two runner-semantics pitfalls were found by direct
experiment and are the main risk for anyone touching these files by hand in the future:

- `node:test` has no describe-level default timeout, and a test context's `t.skip()` does not
  halt execution the way Mocha's `this.skip()` did — every bare `this.skip();` in this codebase
  relied on Mocha's throw-to-halt behavior with no following `return`, so every converted call
  site needed an explicit `return` added after `t.skip()`, or the rest of the test body would
  keep running against an environment the skip was meant to guard against.
- A single-parameter `function (done)` test or hook body is silently reinterpreted by `node:test`
  as the synchronous/async `(t)` form: the test is reported complete the instant the function
  returns, without ever waiting on `done`. Every done-callback body needed a second parameter
  (`(t, done)`) to keep working as a callback-style test.

`scripts/deployment-runner.js` now runs `node --test --test-concurrency=1` instead of the mocha
binary. The concurrency pin is required: `node:test` parallelizes across spec files by default,
and this suite's files share one live Redis/Valkey server per deployment and mutate global
server state (`CONFIG SET`, ACL users, `SLOWLOG`) — running them concurrently reproduced a real
race (a `SLOWLOG` assertion observing another file's in-flight command). `package.json` gained
`test:node`/`test:node:all` in place of `test:mocha`/`test:mocha:all`, and the `mocha`
devDependency was dropped entirely, removing four vulnerable transitive packages from the dev
tree.

**Final acceptance gate correction.** Drop `npm run test:compat` from the command list below —
that script was never implemented (the 2026-08-08 amendment above already superseded the
minimum-version matrix it would have tested) and does not exist in `package.json`.

**Release-publishing correction — 2026-08-09.** The release-publishing section below is the
original Step 12, executed as Step 13 after the test-runner migration. Its release gate is the
workflow's current latest Redis/Valkey matrix; it must not mention a minimum-version or
compatibility suite. Release-tag/package-version equality applies to GitHub Release events
only. The intentionally retained `workflow_dispatch` escape hatch publishes the package
version from the selected ref and has no release tag to compare.

## Summary and decisions

- Release as `3.0.0`: ioredis v6, RESP3 negotiation, reconnect defaults, and the raw
  client exposed by `redis-instance` are externally observable changes.
- Use RESP3 by default with ioredis's default `replyMapping: "legacy"` so existing
  Node-RED payload types remain stable. Add neither a protocol selector nor custom
  fallback logic; ioredis already performs its documented narrow fallback. See the
  [ioredis upgrade guide](https://github.com/redis/ioredis/wiki/Upgrading-from-v5-to-v6).
- Formally support Redis `6.2.3+` and Valkey `7.2.5+`; test both minimum versions. Redis
  Functions remain a Redis/Valkey 7+ feature.
- Make Redis `8.10.0` the primary server, command-catalog, topology, and editor test target.
  Fully support its client-visible additions through the existing generic `redis-command`
  path, with focused UI suggestions, help, and regression tests. Do not add specialized node
  types or per-command forms. Use the official
  [Redis 8.10 release notes](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.10-release-notes/)
  as the scope checklist.
- Add Unix sockets as a transport under existing **Single** mode. Save
  `{ "path": "/run/redis/redis.sock" }` in the existing options field; do not introduce
  a new runtime connection model or flow schema. See
  [ioredis socket support](https://github.com/redis/ioredis#connect-to-redis).
- Preserve the repository's existing GitHub Actions OIDC release design from `dd8dec0`:
  publish when a GitHub Release is published, retain the manual-dispatch escape hatch, and
  use no GitHub environment or npm token. Treat
  [node-red-contrib-dapr-http](https://github.com/pauldeng/node-red-contrib-dapr-http/blob/main/.github/workflows/release.yml)
  as corroboration for token-free OIDC mechanics only; this repository's workflow and
  `docs/CHANGE_WORKFLOW.md` remain authoritative for its trigger and trust configuration.

## Dependency update

| Dependency  | Current | Target |
| ----------- | ------: | -----: |
| ioredis     |  5.11.1 |  6.0.0 |
| lint-staged |  17.1.0 | 17.3.0 |
| mocha       |  11.7.6 | 11.8.0 |
| node-red    |   5.0.1 |  5.0.4 |
| playwright  |  1.61.1 | 1.62.1 |
| prettier    |   3.9.5 |  3.9.6 |

Keep `husky@9.1.7` and `node-red-node-test-helper@0.3.6`; they are current. Refresh
`package-lock.json` once, require `npm outdated --json` to be empty, and retain the existing
Node.js and Node-RED runtime floors.

The tested candidate has zero production vulnerabilities. Remaining audit findings are
transitive development dependencies; record them, but do not use `npm audit fix --force` or
downgrade Node-RED or Mocha to satisfy misleading fixes.

## Step-by-step implementation

### 1. Establish the baseline

Use Node.js 24 and run a clean install, formatting check, production audit, full Docker suite,
Playwright suite, and package dry-run. Record failures before changing dependencies so new
failures can be attributed accurately.

### 2. Add characterization tests first

- Preserve v5-compatible results for uppercase `XREAD`, `XREADGROUP`, sorted-set commands
  with scores, `HRANDFIELD`, and `VSIM`.
- Keep the intentional flat-array `HGETALL` contract.
- Cover initial subscribe with `enableOfflineQueue: false`.

These tests should pass on ioredis v5, then expose any v6 compatibility gaps before the
runtime adaptation is applied.

### 3. Update the package and lockfile

Update `package.json` to `3.0.0`, apply all direct dependency updates together, and regenerate
only the lockfile. Add no production dependencies.

### 4. Adapt runtime behavior narrowly

- Let ioredis provide protocol 3 and legacy reply-mapping defaults.
- Extend the existing lowercase dispatch set to commands whose ioredis v6 argument or reply
  transformers are case-sensitive: `HSET`, `HMSET`, `MSET`, `MSETNX`, `HRANDFIELD`, `VSIM`,
  `XREAD`, `XREADGROUP`, and the sorted-set pair commands registered by ioredis.
- Continue bypassing the `HGETALL` transformer.
- Delay the initial pub/sub subscription until `ready` when necessary, removing the temporary
  listener during close; retain ioredis auto-resubscription afterward.
- Do not change connection ownership, sharing keys, blocking-node shutdown, or retry
  abstractions.

### 5. Add Unix socket editor support

- Add a **Transport: TCP / Unix socket** selector inside **Single** mode; TCP remains the
  default.
- Show host, port, and TLS for TCP and one socket-path field for Unix sockets. Username,
  password, and logical DB remain shared.
- Serialize sockets as `{path, username?, password?, db?}` and remove stale `host`, `port`,
  `family`, and `tls` fields.
- When returning to TCP, remove `path`, because ioredis gives it precedence over host and
  port.
- Require a non-empty path and recommend an absolute path without imposing additional
  OS-specific validation.
- Reuse the existing credentials extraction, connection-test endpoint, `new Redis(options)`
  runtime path, and environment-variable parsing.
- Scope socket support to local standalone Redis/Valkey. Do not offer it for Cluster,
  Sentinel, TLS, or Windows named pipes.

No runtime constructor or saved-flow schema change is required: ioredis already supports
`{path: "/path/to/redis.sock"}` and gives the path precedence over TCP options.

### 6. Promote the primary test target to Redis 8.10

- Change every default modern Redis image from `redis:8.8-alpine` or `redis:7.2-alpine` to
  `redis:8.10-alpine`: standalone, ACL-authenticated, Cluster, Sentinel, and Playwright.
- Retain the separate Redis 6.2.3 and Valkey 7.2.5 compatibility profile so raising the
  current-feature target does not silently raise the supported minimum.
- Rename `test/redis_8_8_data_types_spec.js` to `test/redis_8_10_commands_spec.js`, update its
  key prefix and all documentation references, and keep capability checks for local runs
  against older or module-less servers.
- Have CI assert `INFO server` reports Redis 8.10.x before running the 8.10 catalog suite so a
  stale image cannot produce misleading skips.

### 7. Expand the Redis 8.10 command catalog

- Derive the exact delta from a live Redis 8.10 `COMMAND LIST`, keeping the existing
  root-command collapse and live-catalog completeness test.
- Add suggestions for `HIMPORT`, `LMOVEM`, `BLMOVEM`, `SUNIONCARD`, `SDIFFCARD`,
  `FT.ALIASLIST`, `TS.NRANGE`, `TS.NREVRANGE`, `TS.READ`, and `TS.QUERYLABELS`.
- Add `BACKUP` to `DATALIST_EXCLUSIONS`. Redis marks its operational subcommands `@admin` and
  `@dangerous`; it remains fully callable by entering `BACKUP` in the free-text command field,
  but should not be promoted beside application commands. Cover the safe `BACKUP HELP` path,
  not backup lifecycle mutations, in automated tests.
- Keep `_FT.DEBUG` excluded; Redis 8.10 adds an internal subcommand under that already excluded
  root.
- Update the cheap static catalog assertions and the live `COMMAND LIST` audit. Do not maintain
  a second generated catalog or add a catalog-generation dependency.

### 8. Cover Redis 8.10 core behavior

- `HIMPORT`: test its prepare/set workflow through `redis-command`, including binary-safe
  payloads, then verify the resulting compact hash through `HGETALL`. Preserve the package's
  documented flat-array `HGETALL` reply contract.
- `LMOVEM` and `BLMOVEM`: test multiple-element list movement, ordering, nil/timeout behavior,
  and clean shutdown. Run `BLMOVEM` with the existing **Block Commands** option so it receives
  a dedicated connection.
- `SUNIONCARD` and `SDIFFCARD`: test result and `LIMIT` behavior. In Cluster, test same-slot
  keys and assert that cross-slot keys surface Redis's error unchanged.
- `XREAD` and `XREADGROUP`: add cases for `MAXCOUNT` and `MAXSIZE`, including combinations with
  existing options, while preserving the legacy Node-RED stream reply shape under RESP3.
- `SCRIPT_RUNNER`: characterize the new `COMMAND INFO` flag and verify it does not change
  command dispatch, catalog filtering, Lua Script mode, or Function mode.
- `SLOWLOG GET`: update the characterization test for Redis 8.10's added total-argument-count
  field and document the server-native reply change. Do not normalize or delete the new field.
- Compact hashes: cover ordinary `HSET`/`HMSET` compatibility and pass-through visibility of
  the new `INFO STATS`, `INFO MEMORY`, `MEMORY STATS`, and `MEMORY USAGE` metrics. The server's
  encoding remains an implementation detail; add no compact-hash toggle or model.

### 9. Cover Redis 8.10 bundled-module behavior

- Search: test `FT.ALIASLIST`, Malay and Tagalog stemming, `FT.AGGREGATE`'s `COLLECT` reducer,
  and deterministic acceptance of `RETURN_STRICT`. Add a RESP3 Cluster regression for
  `FT.SEARCH ... LIMIT` so the Redis 8.10 result-count fix is protected at this package's
  protocol boundary.
- JSON: add table-driven `JSON.GET`/`JSON.SET` cases covering each newly documented JSONPath
  operator/function family. Redis parses JSONPath; the node must pass expressions through
  byte-for-byte and return Redis errors unchanged.
- Time Series: test `TS.NRANGE`, `TS.NREVRANGE`, `TS.READ`, and `TS.QUERYLABELS`, plus
  `EXCLUDEEMPTY` on `TS.MRANGE` and `TS.MREVRANGE`. Exercise both immediate and blocking
  `TS.READ`; use **Block Commands** for the blocking case and verify redeploy shutdown.
- Keep these cases in the Redis 8.10-only capability-gated suite. The minimum Redis and Valkey
  profiles must not fail because bundled modules or 8.10 commands are absent.

### 10. Add compatibility and changed-behavior coverage

- Introduce `npm run test:compat`, reusing the existing Docker deployment runner rather than
  creating another runner.
- Run focused unauthenticated and ACL-authenticated tests against `redis:6.2.3-alpine` and
  `valkey/valkey:7.2.5-alpine`.
- Assert successful RESP3 negotiation, SET/GET, pub/sub, stream and sorted-set legacy shapes,
  connection cleanup, and authentication through `HELLO 3 AUTH`.
- Add a temporary bind-mounted Unix socket deployment with TCP disabled. Verify config-node
  connection testing and normal runtime commands over the socket, then remove the temporary
  directory.
- Add Playwright coverage for transport selection, JSON persistence, credential separation,
  blank-path validation, and switching back to TCP without retaining `path`.
- Add Redis 8.10 regression cases for stricter ACL key checks on `SORT`, `GEORADIUS`,
  `GEORADIUSBYMEMBER`, `XREAD`, and `XREADGROUP`; stricter invalid `SET` option combinations;
  and `VADD ... CAS SETATTR`. Assert errors reach `done(err)` unchanged rather than adding
  client-side policy.
- Keep AWS MemoryDB tests opt-in.

## Redis 8.10 impact assessment

| Redis 8.10 change                                                                      | Package impact and decision                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact hashes and `HIMPORT`                                                           | New generic-command coverage and metrics checks; no editor toggle or custom representation.                                                                                                         |
| `LMOVEM`, `BLMOVEM`, `SUNIONCARD`, `SDIFFCARD`                                         | Add catalog entries and end-to-end tests; use the existing dedicated connection for blocking commands and Redis's normal same-slot rule in Cluster.                                                 |
| `BACKUP`                                                                               | Support through the free-text generic command, but exclude it from suggestions because its operational subcommands are `@admin @dangerous`; do not turn a flow node into a backup orchestrator.     |
| `XREAD`/`XREADGROUP` limits                                                            | Support `MAXCOUNT` and `MAXSIZE` through `redis-command` and protect reply mapping. Do not add low-value fields to the curated `redis-in` node; its single-stream consumer loop remains compatible. |
| `SCRIPT_RUNNER` flag and `SLOWLOG GET` reply                                           | No dispatch branch for the metadata flag; preserve Redis's expanded slow-log reply and document the observable shape change.                                                                        |
| Search additions and timeout policy                                                    | Add command/option coverage. A stricter timeout or partial-result policy is server behavior and must not be hidden or retried by the node.                                                          |
| JSONPath extensions                                                                    | Pass through unchanged and cover every new expression family with data-driven tests; do not implement a JSONPath parser.                                                                            |
| Time Series additions                                                                  | Add catalog and end-to-end coverage; use the existing block option for blocking `TS.READ`.                                                                                                          |
| ACL and argument-validation fixes                                                      | Restricted users and invalid `SET` combinations may now receive errors where Redis 8.8 accepted the request. Preserve and document those server errors.                                             |
| TLS peer certificate server-to-server authentication                                   | No Node-RED setting: this authenticates Redis nodes to one another, not this client to Redis. Existing client TLS options remain unchanged.                                                         |
| New compact-hash config, metrics, performance work, CLI changes, and Modules API hooks | Validate generic `CONFIG`/`INFO`/`MEMORY` pass-through where client-visible. The rest is server-operational and requires no runtime or editor code.                                                 |

This is full Redis 8.10 support at the package boundary: every client-visible addition is
discoverable or deliberately classified, executable through the existing generic command
surface, documented, and tested. It does not duplicate Redis server administration or parsing
inside Node-RED.

### 11. Migrate test runner: Mocha → `node:test`

Not in the original plan; inserted here mid-implementation. See the 2026-08-09 amendment above
for the full record — summary only:

- Replace Mocha with Node's built-in test runner across all spec files; keep
  `node-red-node-test-helper` (Node-RED-specific, no native replacement) and `should.js`
  (works unchanged).
- Add an explicit `return` after every `t.skip()` and a second `t` parameter to every
  done-callback test/hook — `node:test`'s skip and callback-arity semantics differ from
  Mocha's in ways that silently produce false-positive passes if missed.
- Run spec files with `--test-concurrency=1`: they share one live Redis/Valkey server per
  deployment and mutate global server state, which races under `node:test`'s default
  cross-file concurrency.
- Drop the `mocha` devDependency; add `test:node`/`test:node:all` npm scripts.

### 12. Update documentation and agent guidance

- Make `AGENTS.md` a regular canonical file and replace `CLAUDE.md` with `@AGENTS.md`, following
  [OpenAI's AGENTS.md guidance](https://developers.openai.com/codex/guides/agents-md) and
  [Claude's documented import pattern](https://code.claude.com/docs/en/memory).
- Keep `AGENTS.md` concise, provider-neutral, below 200 lines, and focused on commands,
  invariants, required reading, testing, and release rules.
- Update the maintainer skill and living docs to reference `AGENTS.md`; retain the existing
  single canonical skill file rather than relocating or duplicating it.
- Document RESP3, legacy reply shapes, Redis 8.10 as the primary target, minimum server
  versions, Function-mode requirements, Unix socket permissions and container mounts, and
  `ENOENT`/`EACCES` troubleshooting.
- Update `redis-command` help with the new command families, Cluster same-slot constraints,
  and the requirement to enable **Block Commands** for `BLMOVEM` or blocking `TS.READ`.
- Call out the Redis-originated `SLOWLOG GET`, ACL, and invalid-`SET` behavior changes as
  observable compatibility notes. Document `BACKUP` as supported by free text but intentionally
  absent from suggestions.
- Leave historical design records unchanged unless a link is broken.
- Add a `3.0.0` changelog entry covering all observable changes, especially RESP3, ioredis v6,
  reconnect/keepalive defaults, raw-client behavior, and Unix sockets.

### 13. Preserve and extend release publishing

- Keep `.github/workflows/release.yml` triggered by `release: types: [published]`, plus its
  existing `workflow_dispatch` escape hatch. Do not add a tag-push trigger or branch-ref job
  guard; `dd8dec0` deliberately replaced that release model.
- Keep only `contents: read` and `id-token: write`, GitHub-hosted Node 24, and the existing npm
  setup.
- Do not add a GitHub `environment`. Keep the npm trusted-publisher registration for
  `pauldeng/node-red-contrib-redis` and `release.yml` with **Environment left empty**, exactly
  as documented in `docs/CHANGE_WORKFLOW.md`. Re-register it only if the repository or
  workflow identity changes.
- Keep the existing release gate: formatting, production audit, the latest Redis/Valkey Docker
  matrix (`npm test`), Playwright, and `npm pack --dry-run` before publishing. Do not add a
  minimum-version compatibility suite or `npm run test:compat`.
- Keep the package-manifest assertion in `release.yml`: it runs `npm pack --dry-run --json` and
  rejects files outside the intended runtime, editor, examples, icons, README assets, changelog,
  license, and package metadata paths.
- For a GitHub Release event, require the release tag (with an optional leading `v`) to equal
  `package.json.version`. For `workflow_dispatch`, document that the selected ref's package
  version is intentionally published without tag comparison; use that escape hatch only for
  an explicit maintainer-controlled recovery.
- Preserve `npm publish --access public --provenance` without `NPM_TOKEN`, `NODE_AUTH_TOKEN`,
  `npm login`, or workstation publishing.

## Public interface and compatibility

- New editor capability: **Single > Transport > Unix socket**.
- The `redis-command` suggestions gain the safe Redis 8.10 command roots listed in Step 7;
  the field remains free text, so older servers fail unsupported commands normally and
  administrative commands remain available without being promoted.
- Persisted representation: the existing `redis-config.options` object gains the already
  supported ioredis `path` option; no new Node-RED config property is introduced.
- TCP remains the default for new and existing flows.
- RESP3 is the default wire protocol. Default Node-RED message payload shapes remain compatible
  with v2 because legacy reply mapping and command-specific transforms are preserved.
- `redis-instance` exposes ioredis v6 and therefore represents a deliberate semver-major raw
  client change.
- Redis 8.10's `SLOWLOG GET` reply has an additional element. ACL enforcement, invalid `SET`
  combinations, and Search timeout behavior also become stricter server-side; the node must
  surface those results without compatibility rewrites.
- Unix sockets are local-process filesystem resources. The Node-RED process or container must
  see the same path and have permission to open it.

## Final acceptance gate

Run successfully from a clean checkout:

```bash
npm ci
npx prettier --check .
npm audit --omit=dev
npm outdated --json
npm test
npx playwright install --with-deps chromium
npm run test:playwright
npm pack --dry-run
```

`npm run test:compat` was dropped; see the 2026-08-09 amendment above.

Confirm the tarball contains only intended package files. After merging, create and publish a
GitHub Release tagged `v3.0.0`; that event triggers the existing workflow without an environment
approval gate. Verify the npm package has provenance attestations, install it into a clean
Node-RED 5 instance, and smoke-test TCP and Unix-socket flows.

## Explicit non-goals

- No RESP selector or custom protocol-fallback layer.
- No new production dependency.
- No separate Unix-socket runtime abstraction or fourth Redis topology.
- No Cluster, Sentinel, TLS, or Windows named-pipe socket support.
- No new specialized node type or bespoke editor form for each Redis 8.10 command; the
  existing generic command surface already provides full argument and reply pass-through.
- No client-side emulation of Redis 8.10 features on older Redis/Valkey versions.
- No automated `BACKUP START` lifecycle or UI for Redis's server-side backup facility.
