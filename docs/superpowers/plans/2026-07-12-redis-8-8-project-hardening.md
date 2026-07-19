# Redis 8.8 Project Hardening Plan

> **For agentic workers:** Follow this plan task-by-task using test-driven development. Do not commit changes without explicit user approval.

**Goal:** Fix confirmed connection and stream bugs, provide durable generic Redis 8.8 command support, refresh dependencies, and align tests and documentation.

**Architecture:** Preserve the existing single-module Node-RED design and public flow properties. Make narrow changes to connection identity, stream-topic parsing, and generic command argument assembly; keep dedicated connection behavior and Redis topology restrictions intact.

**Tech Stack:** Node.js 24, Node-RED 5, ioredis 5, Redis 8.8 standalone, Redis 7.2 Cluster/Sentinel, Mocha, Playwright, and Docker Compose.

## Global Constraints

- Do not rename public node types, config fields, message fields, or editor ids.
- Preserve existing flow JSON compatibility.
- Write the failing regression test before each runtime fix.
- Use `async`/`await` with `try`/`catch` in new or modified asynchronous code.
- Do not change connection shutdown behavior beyond the proposed pool-key correction.
- Do not commit any changes without explicit user approval.

## Review Findings

- Shared connections use editable config names, allowing same-name configs to send commands to the wrong Redis server.
- `XREADGROUP` rejects normal namespaced stream keys containing colons.
- At review time, the editor omits 86 Redis 8.8 command names and displays 68 obsolete module commands.
- `redis-command` ignores explicit numeric, boolean, and empty-string payloads.
- Missing or invalid config nodes cause operational nodes to fail construction unclearly.
- Four direct development dependencies and numerous transitives have updates available.
- Documentation, formatting, test-count, and Node-RED version details have drifted.

Redis 8.8 is the baseline, using its official [command catalog](https://redis.io/docs/latest/commands/redis-8-8-commands/) and [data-type catalog](https://redis.io/docs/latest/develop/data-types/).

## Task 1: Correct Shared Connection Identity

**Files:**

- Modify: `redis.js`
- Test: `test/redis_lua_conn_spec.js`, `test/redis_out_spec.js`, `test/redis_command_spec.js`
- Update: `docs/ARCHITECTURE.md`, `docs/REFERENCE_MAP.md`

- [ ] Add focused failing tests for `redis-out`, `redis-command`, and `redis-lua-script` using differently configured `redis-config` nodes that retain the same default display name, `Local`.
- [ ] Prove each affected node uses the correct server or database.
- [ ] Replace shared pool keys based on `server.name` with the unique saved config-node id, `n.server`.
- [ ] Preserve per-node ids for blocking and subscriber connections.
- [ ] Capture the chosen id once and use the same value for `getConn` and `disconnect`.
- [ ] Re-run connection isolation, status, reference-count, and shutdown tests.

## Task 2: Handle Missing or Invalid Redis Configs

**Files:**

- Modify: `redis.js`
- Test: matching constructor/status specs

- [ ] Add failing tests for an absent config-node reference and a config node with invalid options.
- [ ] Make `getConn` throw a clear error for a missing config node or unusable options instead of returning `undefined`.
- [ ] Ensure no caller attempts to attach listeners to an undefined client.
- [ ] Preserve existing Redis connection errors and status behavior for valid configs.

## Task 3: Support Namespaced XREADGROUP Stream Keys

**Files:**

- Modify: `redis.js`, `redis.html`
- Test: `test/redis_in_spec.js`
- Update: `examples/redis-streams.json`, `docs/NODE_GUIDE.md`, `README.md`

- [ ] Add a failing `redis-in` test using a topic such as `test:in:stream:>`.
- [ ] Split the configured topic at its final colon so the stream key may contain colons.
- [ ] Add a short code comment recording the invariant: Redis stream IDs cannot contain colons, so the final colon is an unambiguous separator.
- [ ] Reject missing stream keys or missing stream IDs with clear editor and runtime validation.
- [ ] Preserve the existing `<stream>:<id>` format for deployed flows.
- [ ] Update help and examples to remove the current no-colon limitation.

## Task 4: Fix redis-command Argument Handling

**Files:**

- Modify: `redis.js`
- Test: `test/redis_command_spec.js`

- [ ] Add failing tests for `msg.payload` values `0`, `false`, `""`, truthy numbers, and `true`.
- [ ] Add failing tests proving `undefined`, `null`, and an absent payload use static Params.
- [ ] Add characterization tests proving empty arrays and empty plain objects suppress static Params and contribute zero extra Redis arguments.
- [ ] Rewrite the input handler using `async`/`await` and `try`/`catch`.
- [ ] Treat payload as explicit only when `msg.payload !== undefined && msg.payload !== null`: spread non-empty arrays, preserve non-empty objects as one argument for ioredis command-specific transforms, and pass other values as one argument.
- [ ] Treat `[]` and an empty plain object `{}` as explicit zero-argument payloads that suppress static Params; do not stringify `{}` to `"[object Object]"`.
- [ ] Treat `undefined` and `null` as absent for compatibility; use configured Params in those cases and document the behavior.
- [ ] Report malformed saved Params through `done(err)`.
- [ ] Build the final call as command plus optional topic plus payload/Params arguments, then return the Redis response in `msg.payload`.
- [ ] Preserve Redis errors through `done(err)` and existing dedicated-connection behavior.

## Task 5: Refresh Dependencies and Audit the Lockfile

**Files:**

- Modify: `package.json`, `package-lock.json`

- [ ] Update `node-red` to `^5.0.1`.
- [ ] Update `playwright` to `^1.61.1`.
- [ ] Update `prettier` to `^3.9.5`.
- [ ] Update `lint-staged` to `^17.0.8`.
- [ ] Retain current ioredis, Mocha, Husky, and test-helper versions because they are already latest.
- [ ] Regenerate the lockfile without `--force`, overrides, or unrelated dependency additions.
- [ ] Run `npm audit --omit=dev`; expected production vulnerabilities: zero.
- [ ] Run full `npm audit` and document findings that remain in current upstream Node-RED or Mocha releases.
- [ ] Do not downgrade packages to satisfy incorrect `npm audit` remediation suggestions.

## Task 6: Make the redis-command Editor Generic

**Files:**

- Modify: `redis.html`
- Test: `test/redis_lua_ui_spec.js`, `test/playwright/redis-editor.spec.js`

- [ ] Add an editor test proving an arbitrary command such as `MYMODULE.CALL` can be saved and reopened.
- [ ] Replace the closed command select with a required editable input and native datalist while retaining the `node-input-command` id and saved `command` property.
- [ ] Set the new-node default to `SET`, fixing the lowercase-default/uppercase-option mismatch; verify existing lowercase saved commands still reopen and execute.
- [ ] Derive the suggestions from the Redis 8.8 command catalog at implementation time.
- [ ] Include Arrays, JSON, probabilistic types, Time Series, and Vector Sets.
- [ ] Remove obsolete AI, Graph, Gears, and retired module suggestions.
- [ ] Continue accepting command names not present in the datalist.
- [ ] Update the Playwright command editor test to fill the new input instead of using the select-only `setSelectValue` helper.

## Task 7: Cover Every Redis 8.8 Data-Type Family

**Files:**

- Extend the narrowest existing command-family specs
- Add a new family spec only when no suitable file exists
- Update: `docs/TESTING.md`, `docs/REFERENCE_MAP.md`, maintainer skill if a spec file is added

- [ ] Keep existing String, Bitmap/Bitfield, Geo, Hash, HyperLogLog, List, Set, Sorted Set, Stream, and Lua coverage.
- [ ] Add representative runtime coverage for Arrays and Vector Sets.
- [ ] Add representative coverage for JSON, Bloom/Cuckoo filters, Count-Min Sketch, t-digest, Top-K, and Time Series when those bundled modules are present.
- [ ] Skip module-specific cases with an explicit capability check when the active Redis deployment does not provide the module.
- [ ] Run Redis 8.8-only Array, Vector Set, `INCREX`, and `XNACK` coverage only in the standalone 8.8 stages or behind explicit capability checks.
- [ ] Keep Cluster and Sentinel topology coverage compatible with their Redis 7.2 images.
- [ ] Do not create one integration test for every catalog command; the generic call path and representative family tests are the contract.

## Task 8: Align Tooling and Documentation

**Files:**

- Modify: `.husky/pre-commit`, `README.md`, `redis.html`
- Update: current architecture, node guide, reference map, testing guide, and canonical agent guidance

- [ ] Run lint-staged formatting before `npm test` in the pre-commit hook.
- [ ] Update the README Node-RED badge from 4.x to 5.x.
- [ ] Correct the `supoerpowers` typo and other directly affected documentation errors.
- [ ] Remove hard-coded Mocha spec counts from current guidance and retain the instruction to enumerate `test/*_spec.js` for the live list.
- [ ] Document config-id pooling, namespaced stream topics, editable command names, explicit payload semantics, and representative Redis 8.8 coverage.
- [ ] State the argument compatibility change explicitly: `0`, `false`, and `""` previously selected static Params when configured and otherwise degraded to topic-only or a bare command; truthy numbers and `true` previously suppressed Params but were ignored; all these scalar values now become Redis arguments, while `[]` and `{}` retain their current zero-argument behavior.
- [ ] Update version references after the dependency refresh.
- [ ] Do not rewrite historical plans/specifications.
- [ ] Format only files touched by this work; defer the unrelated repository-wide formatting backlog.

## Verification

- [ ] Confirm `node --version` reports Node.js 24.x in the verification environment.
- [ ] Run focused failing tests before each implementation, then rerun them after the fix.
- [ ] Run Redis-independent UI/config specs.
- [ ] Run relevant command, stream, connection, status, Lua, Cluster, and Sentinel specs.
- [ ] Run `npm test` for the complete Docker deployment matrix.
- [ ] Run `npm run test:playwright` for editor persistence and command-input behavior.
- [ ] Run `npm audit --omit=dev` and full `npm audit`.
- [ ] Run Prettier checks on touched files.
- [ ] Run `npm pack --dry-run` and inspect the published artifact.
- [ ] Run MemoryDB tests only when the opt-in credential environment is available.
- [ ] Confirm `git diff --check` passes and review the final diff without committing it.

## Acceptance Criteria

- Same-name Redis configs never share a client across config-node ids.
- Existing sharing, blocking isolation, reference counting, reconnect, and shutdown behavior still pass.
- `XREADGROUP` accepts namespaced keys while preserving existing topic syntax.
- `redis-command` accepts arbitrary command names and explicit scalar payload values; `undefined` and `null` retain static Params fallback behavior, while `[]` and `{}` explicitly contribute zero extra arguments without selecting Params.
- Every Redis 8.8 data-type family has a supported generic path and representative coverage where server capabilities permit it.
- Production dependency audit reports zero vulnerabilities.
- Runtime, editor help, README, project docs, examples, and tests describe the same behavior.
- No public node types or saved property names change.
- No commit is created.

## Assumptions and Deferred Work

- Server-side modules and ACL permissions remain deployment responsibilities.
- Administrative, blocking, and multi-key commands retain their Redis topology restrictions.
- Full verification requires Docker socket access or passwordless Docker sudo; the current shell does not have it.
- The existing repository-wide formatting backlog and wholesale callback-test conversion are separate maintenance work.
- Package-layout reduction is not included because the current package size is not a functional blocker.

## Amendment (2026-07-19)

This plan is a historical record of the scope as originally proposed on 2026-07-12 and is
left otherwise unchanged. Two of the assumptions above were superseded during execution and
review; recorded here rather than edited above:

- **Package-layout reduction**, deferred above, was subsequently brought into scope by an
  explicit maintainer decision (see `docs/REDIS_8_8_HARDENING_REVIEW.md`, "Human decisions"
  item 3, and its Finding 7) and implemented: `package.json` now declares a `files`
  allowlist, reducing the published tarball from 90 files/1.2 MB to 18 files/~325 KB. The
  packed tarball was installed into a clean Node-RED 5.0.1 environment and verified to
  register the node and run a representative Redis flow.
- **Docker verification availability**, described above as unavailable in the shell that
  drafted this plan, was available in the environment that executed it: the complete
  Docker-managed matrix (`npm test` — standalone unauthenticated/authenticated, Cluster,
  Sentinel) and the full Playwright suite (`npm run test:playwright`) both ran to completion
  with all tests passing.
