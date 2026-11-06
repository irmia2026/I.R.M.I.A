# Plugin Platform P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver installable, reviewable, trust-gated plugin packages with Skills, Hooks and MCP contributions, restart-effective manual enable/disable, and automatic circuit-breaking with half-open recovery.

**Architecture:** Install immutable content-hashed packages under the data directory, derive trust, enabled and circuit state from internal events, and compose permitted contributions through one runtime path. Keep built-in configuration independent, merge plugin MCP declarations at every consumer, and limit automatic lifecycle changes to quarantine/recovery without implementing general Runtime Profile hot switching.

**Tech Stack:** TypeScript on Node 22 built-ins, `node:test`, Flutter/Dart with existing Material and `flutter_test`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-runtime-profile-hot-switch-plugin-design.md` (P0 in §12, constraints in §9 and §11)

## Global Constraints

- P0 supports only `skills`, `hooks` and `mcp`; prompt, persona, UI and provider contributions are rejected as unsupported until P1.
- Manual enable/disable is restart-effective; only circuit quarantine/recovery changes runtime contributions at turn boundaries.
- Circuit trips after 3 consecutive systemic failures on one contribution, cools down from 30s exponentially to a 15m cap, and permits one half-open probe; business errors do not count.
- Trust is bound to the whole package content hash; changed content is untrusted again.
- Third-party executable contributions remain trusted code; process isolation is not presented as a security sandbox.
- Plugin tools use MCP only; no in-process dynamic import and no arbitrary Dart/JavaScript UI.
- Plugin packages and their configuration are read-only to the agent.
- Existing standalone Skills, Hooks and MCP behavior must remain compatible.
- New plugin events are `internal`; old logs without them remain valid.
- Use existing test conventions and real temporary directories; do not add dependencies.
- Do not automatically commit or push; the user has not requested Git mutations.

## Review Focus

- Symlinks, path traversal and source/destination recursion must not escape or recursively copy a package; covered by Task 1 tests.
- Duplicate Skill names and MCP names must be deterministic and visible rather than silently replacing built-ins; covered by Tasks 3 and 4 tests.
- A broken plugin must not prevent built-in contributions or the process from starting; covered by Tasks 2 and 4 tests.
- An MCP config hot reload must not remove plugin servers from the pool or index; covered by Task 4 tests.
- Unconfirmed or hash-mismatched packages must never become active; covered by Task 2 tests.
- Repeated business errors must not trip the circuit, concurrent probes must not multiply, and restart must preserve cooldown; covered by Task 5 tests.
- The UI must distinguish untrusted, disabled, quarantined, probing and enabled-pending-restart states; covered by Task 7 tests.

---

### Task 1: Manifest Validation and Immutable Package Store

**Files:**
- Create: `src/plugin/manifest.ts`
- Create: `src/plugin/package-store.ts`
- Test: `test/plugin-package.test.ts`

**Interfaces:**
- Produces: `parsePluginManifest(raw: unknown, where?: string): PluginManifest`.
- Produces: `scanPluginPackage(rootDir: string): PluginPackage`.
- Produces: `installPluginPackage(sourceDir: string, dataDir: string): PluginPackage`.
- Produces: `pluginPackagesRoot(dataDir: string): string` and `PLUGIN_FILE_LIMITS`.
- `PluginPackage = { rootDir, contentHash, fileCount, totalBytes, manifest }`.

- [ ] **Step 1: Write failing manifest and store tests**

Cover: valid Skills/Hooks/MCP manifest; P1 contribution rejection; invalid id/version/engine; exact and `>=` engine requirements including prerelease ordering; deterministic hash independent of directory enumeration; duplicate install idempotence; `..`, absolute contribution paths, symlink files/directories, file-count/size overflow and source-inside-destination rejection.

Use limits pinned by implementation: 256 files, 1 MiB per file, 8 MiB total. Manifest id is 1–64 lowercase letters/digits/hyphens; apiVersion is exactly `1`. Engine accepts exact or `>=` Node-style semantic versions, rejecting other expressions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-package.test.ts`
Expected: FAIL because the plugin modules do not exist.

- [ ] **Step 3: Implement strict manifest parsing**

Define immutable contribution shapes `skills: string[]`, optional `hooks: string`, optional `mcp: string`, and `permissions: string[]`. Reject non-JSON shapes and unsupported executable/UI/provider fields. Validate semantic engine compatibility against `AGENT_VERSION` without importing `main.ts`; pass the current version as an argument to the compatibility helper to avoid a dependency cycle.

- [ ] **Step 4: Implement hashed immutable installation**

Scan sorted regular files, reject every symbolic link and non-regular entry, and hash `relativePosixPath + NUL + bytes`. Install to `<dataDir>/plugins/packages/<id>/<contentHash>/` through a sibling temporary directory and atomic rename. Re-scan the destination before returning; an existing identical directory is idempotent, while hash/content mismatch is an error.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test --experimental-strip-types test/plugin-package.test.ts && npx tsc --noEmit`
Expected: PASS.

### Task 2: Trust Events and PluginManager

**Files:**
- Modify: `src/log/types.ts` near Skill events and the AppEvent union/visibility table
- Create: `src/plugin/manager.ts`
- Test: `test/plugin-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 `PluginPackage`, `scanPluginPackage` and `pluginPackagesRoot`.
- Produces: `PluginManager` with `setEvents`, `list`, `install`, `confirm`, `setEnabled`, `active`, and `recordFailure`; Task 5 adds circuit-event writers.
- Produces: `PluginView = { package, state, problems, requiresRestart, circuit? }`, where state is `untrusted | disabled | enabled | invalid | quarantined | probing`; circuit metadata is added by Task 5.
- Produces: `ActivePluginContributions = { skillRoots, hookEntries, mcpServers, warnings }` consumed by Tasks 3–4.

- [ ] **Step 1: Write failing event and lifecycle tests**

Assert: install alone is untrusted; confirm binds id+hash; enable requires confirmation; disable/enable last-event-wins; an upgraded hash does not inherit trust; a tampered package is invalid; duplicate commands do not emit duplicate events; all event visibilities are internal; old unrelated events do not change state.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-manager.test.ts`
Expected: FAIL because manager and event types are absent.

- [ ] **Step 3: Add plugin event contracts**

Add `PluginInstalled { id, version, contentHash, path, by:'human' }`, `PluginEnabled { id, contentHash }`, `PluginDisabled { id, contentHash }`, and `PluginFailed { id, contentHash, reason }`. Add them to `AppEvent` and explicitly to `EVENT_VISIBILITY` as `internal`; do not add projection state that duplicates PluginManager’s event fold.

- [ ] **Step 4: Implement PluginManager**

`setEvents(events)` folds by ascending seq. `install(sourceDir)` copies without trusting. `confirm(id, contentHash)` and `setEnabled(id, contentHash, enabled)` validate the scanned package, emit through the injected event sink, then update the local fold only after the sink succeeds. `list()` reports `requiresRestart: true` for enabled-state differences. `active()` includes only confirmed+enabled+valid packages sorted by id/hash, collects contribution problems without activating that package, and never throws away built-in operation.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test --experimental-strip-types test/plugin-manager.test.ts && npx tsc --noEmit`
Expected: PASS.

### Task 3: Skill, Hook and MCP Contribution Adapters

**Files:**
- Create: `src/plugin/contributions.ts`
- Modify: `src/skill/skills.ts` SkillManager options/scan/trust logic
- Modify: `src/hook/hooks.ts` HookConfigEntry and process cwd selection
- Test: `test/plugin-contributions.test.ts`
- Modify: `test/skills.test.ts`
- Modify: `test/hooks.test.ts` if present; otherwise add hook assertions to `test/plugin-contributions.test.ts`

**Interfaces:**
- Consumes: Task 2 active packages.
- Produces: `PluginSkillRoot = { dir, rootName, packageHash }`.
- Produces: `composePluginMcp(packages, extraLaunchers): { servers, warnings }`.
- Produces: `composePluginHooks(packages): { entries, warnings }`.
- SkillManager accepts `packageRoots?: readonly PluginSkillRoot[]`.

- [ ] **Step 1: Write failing adapter tests**

Assert: plugin Skill enters catalog only through packageRoots without a second `skill/installed`; built-in Skill trust remains unchanged; built-in roots win duplicate names deterministically; plugin Hook defaults cwd to its package and explicit relative cwd stays inside it; HookRunner uses per-entry cwd; MCP names are namespaced and cwd defaults to the package; launcher validation still applies; overlong/colliding names produce warnings rather than silent replacement.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-contributions.test.ts test/skills.test.ts`
Expected: FAIL on packageRoots and per-entry cwd.

- [ ] **Step 3: Extend SkillManager without changing standalone semantics**

Add absolute package root descriptors alongside existing relative rootNames. `rootName` is the deterministic display/read path relative to baseRoot where possible. Candidates carry their root identity; package-root candidates are trusted by the enabled package hash, while ordinary candidates continue through `trustOf`. Preserve deterministic root priority and readOnlyPrefixes.

- [ ] **Step 4: Implement Hook and MCP composition**

Add optional `cwd` to HookConfigEntry, parse it conservatively, and use `entry.cwd ?? runner.cwd` at spawn. Parse plugin hook files with existing `loadHookConfig`; resolve omitted/relative cwd against the package and reject escapes. Parse MCP through `parseMcpServers` with existing extraLaunchers, then produce names `<pluginId>__<serverName>` within the 128-character limit. Default cwd to package root and preserve all side-effect/tool attributes.

- [ ] **Step 5: Run focused and regression tests**

Run: `node --test --experimental-strip-types test/plugin-contributions.test.ts test/skills.test.ts test/hooks.test.ts && npx tsc --noEmit`
Expected: PASS; if `test/hooks.test.ts` does not exist, run the actual Hook test file found during implementation.

### Task 4: Production Composition and MCP Consumer Consistency

**Files:**
- Create: `src/plugin/runtime.ts`
- Modify: `src/main.ts` startup composition before protected paths/MCP construction
- Modify: `src/runtime/real-loop.ts` RealLoopDeps and MCP index read points
- Test: `test/plugin-runtime.test.ts`
- Modify: `test/mcp-index.test.ts`
- Modify: `test/mcp-config-hot-reload.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 manager and contribution composers.
- Produces: `mergeMcpDeclarations(configServers, pluginServers): McpServerEntry[]` with duplicate-name validation.
- Produces: optional `RealLoopDeps.mcpDeclarations?: () => readonly McpServerEntry[]`, defaulting to current config behavior.
- Produces: `pluginProtectedPaths(dataDir): string[]`.

- [ ] **Step 1: Write failing composition tests**

Assert built-in-only behavior is unchanged; enabled plugin Skill/Hook/MCP appears in runtime composition; disabled/untrusted/invalid packages do not; duplicate built-in vs plugin MCP names are rejected with a diagnostic; `mergeMcpDeclarations` is stable across config hot reloads; RealLoop index reads the same merged declarations as the pool; plugin roots are protected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-runtime.test.ts test/mcp-index.test.ts test/mcp-config-hot-reload.test.ts`
Expected: FAIL on merged declaration support.

- [ ] **Step 3: Implement one runtime composition path**

Construct PluginManager from recovered events before protected paths and MCP pool creation. Keep the startup active snapshot fixed for P0. Merge built-in and plugin MCP servers for initial pool construction and every ConfigWatcher `applyDeclarations` call. Pass the same merger through `mcpDeclarations` to RealLoop index/count read points. Do not write plugin declarations back into `config.json`.

- [ ] **Step 4: Wire Skills, Hooks and protection**

Pass active packageRoots to the production SkillManager, append enabled plugin Hook entries to built-in entries, and protect the whole plugin package store through existing fs/media protectedPaths. Log per-package problems and continue with valid built-ins/plugins. Do not start plugin MCP processes eagerly.

- [ ] **Step 5: Run composition and regression tests**

Run: `node --test --experimental-strip-types test/plugin-runtime.test.ts test/mcp-index.test.ts test/mcp-config-hot-reload.test.ts test/main-entry.test.ts && npx tsc --noEmit`
Expected: PASS.

### Task 5: Circuit Breaker and Half-Open Recovery

**Files:**
- Create: `src/plugin/failures.ts`
- Create: `src/plugin/circuit-breaker.ts`
- Modify: `src/plugin/manager.ts`
- Modify: `src/log/types.ts`
- Modify: `src/hook/hooks.ts` failure metadata and replaceable entries
- Modify: `src/mcp/client.ts` systemic-failure signal
- Modify: `src/skill/skills.ts` replaceable package roots
- Modify: `src/runtime/real-loop.ts` turn-boundary callback
- Modify: `src/main.ts` circuit start/stop and runtime application
- Test: `test/plugin-circuit-breaker.test.ts`
- Modify: `test/mcp-client.test.ts` or the actual MCP lifecycle test file

**Interfaces:**
- Produces: `PluginFailure = { pluginId, contentHash, contributionKind, contributionName, category, message }`.
- Produces: `PluginCircuitBreaker` with `noteFailure`, `noteSuccess`, `start`, `stop`, and `drain`.
- Produces: `mcpDeclarations(): readonly McpServerEntry[]` and `applyPluginRuntime(): Promise<void>` for one merged runtime application path.
- Produces: `RealLoopDeps.onTurnBoundary?: () => Promise<void>`; existing callers without it are unchanged.

- [ ] **Step 1: Write failing deterministic circuit tests**

Use an injected clock. Assert three consecutive systemic failures on one contribution quarantine the whole plugin; successes reset only that contribution; business `isError`, bad arguments, denial, overload and cancellation never count; quarantine persists across reconstructed events; cooldown is 30s doubling to a 15-minute cap; only one half-open probe exists; success recovers and failure backs off again; manual disable/untrusted/invalid packages never auto-probe.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-circuit-breaker.test.ts`
Expected: FAIL because circuit contracts do not exist.

- [ ] **Step 3: Add circuit events and failure classification**

Add internal `plugin/quarantined`, `plugin/probe-started` and `plugin/recovered` with id/hash, contribution, category, count and retry/probe timestamps. Extend PluginManager state with `quarantined | probing`, retryAt and lastError. Implement the explicit systemic-failure classifier; never infer faults from arbitrary tool-result text.

- [ ] **Step 4: Emit reliable failure signals**

Add optional plugin identity to Hook entries/events and count HookRunner `error|timeout`. Add an MCP host failure callback for start failure, protocol failure, crash and timeout; do not signal business tool errors. Preserve existing MCP fallback, backoff and tool-result behavior.

- [ ] **Step 5: Apply isolation and recovery at turn boundaries**

Persist quarantine before runtime mutation. Remove the package’s Skill roots, Hook entries and MCP declarations through the same merged path used by config hot reloads, then force the next Skill index rebuild. Invoke `onTurnBoundary` after a turn settles and before a new one; do not mutate the active turn. `drain()` applies pending changes without waiting for a timer.

- [ ] **Step 6: Implement half-open probes**

After cooldown, allow one probe per plugin: rescan Skills and Hook config, and call real MCP `listTools` without eager startup elsewhere. Never execute a synthetic Hook; Hook-only plugins allow exactly one real invocation as their probe. Record recovery only after required probes succeed, then restore contributions at a turn boundary. Start/stop timers with the main process and restore remaining cooldown after restart.

- [ ] **Step 7: Run circuit and runtime regression tests**

Run: `node --test --experimental-strip-types test/plugin-circuit-breaker.test.ts test/plugin-runtime.test.ts test/mcp-config-hot-reload.test.ts && npx tsc --noEmit`
Expected: PASS.

### Task 6: Local Plugin API

**Files:**
- Create: `src/plugin/http.ts`
- Modify: `src/web/server.ts` WebServerDeps, GET router and command switch/confirmation map
- Test: `test/plugin-commands.test.ts`

**Interfaces:**
- Consumes: Task 2 PluginManager and Task 5 circuit state.
- Produces: optional `WebServerDeps.plugins?: PluginManager`.
- Produces: `GET /api/plugins`.
- Produces: `POST /api/commands/plugin-install|plugin-confirm|plugin-enable|plugin-disable`.

- [ ] **Step 1: Write failing HTTP contract tests**

Use the existing real server/temp-dir pattern. Assert install does not trust; confirm emits installed; enable/disable emits the matching event and returns `restartRequired:true`; wrong hash, relative source path, invalid package and duplicate action are safe; GET reports contributions/problems plus quarantine reason, contribution, count and retryAt without secrets; missing manager returns 501; all write commands require their confirmation phrase.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-strip-types test/plugin-commands.test.ts`
Expected: FAIL with 404/unknown command.

- [ ] **Step 3: Implement the thin HTTP adapter**

Keep request parsing, response shaping and error mapping in `plugin/http.ts`; register routes in server without moving unrelated server code. Install accepts an absolute local source directory only. Confirm/enable/disable require id+contentHash. Emit through PluginManager and return fresh `list()` state rather than a second status calculation.

- [ ] **Step 4: Inject the production manager**

Pass the same PluginManager instance from `main.ts` into `startWebServer`; do not construct a second event/trust store. Existing servers without the dependency retain current behavior, with only the new routes returning 501.

- [ ] **Step 5: Run API and related extension tests**

Run: `node --test --experimental-strip-types test/plugin-commands.test.ts test/extensions-commands.test.ts && npx tsc --noEmit`
Expected: PASS.

### Task 7: Extensions UI, Documentation and Full Verification

**Files:**
- Create: `gui/lib/pages/plugins_panel.dart`
- Modify: `gui/lib/pages/extensions_page.dart`
- Modify: `gui/lib/i18n/app_strings.dart`
- Test: `gui/test/plugins_panel_test.dart`
- Modify: `gui/test/extensions_page_test.dart` fake routes as needed
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 6 API shapes.
- Produces: a Plugins section in the existing Extensions page; no new navigation page.

- [ ] **Step 1: Write failing widget tests**

Cover empty/loading/error states; local absolute path install; untrusted review and confirm; disabled enable; enabled disable; hash-mismatch invalid state; quarantined/probing status, reason and next retry; and visible “restart required” copy for manual enable/disable. Assert confirmation phrases and id+hash are sent. Use the existing fake API and add `/api/plugins` to shared fixtures.

- [ ] **Step 2: Run widget tests to verify they fail**

Run from `gui/`: `flutter test test/plugins_panel_test.dart`
Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement the plugin panel**

Follow ExtensionsPage’s existing list/detail, StateBlock, confirmation and polling idioms. Show id/version/hash, contribution counts, permissions, problems and trust/circuit state. Keep install and confirm separate. Disable trust-dependent actions when invalid/untrusted and never display “active now” after manual enable/disable. Show quarantine separately from manual disable.

- [ ] **Step 4: Update user-facing documentation**

Document package layout, local install/review/enable flow, three P0 contribution types, whole-hash trust, restart effectiveness and trusted-code boundary. Document the 3-failure threshold, 30s→15m cooldown, half-open probe and errors that do not count. Add an Unreleased changelog entry and remove any implication that manual plugin enablement is already hot.

- [ ] **Step 5: Run complete project verification**

Run from repository root: `npx tsc --noEmit && npm test`
Run from `gui/`: `flutter analyze && flutter test`
Expected: all PASS with no new analyzer warnings.

- [ ] **Step 6: Exercise the real P0 scenario end to end**

Build with `npm run build`; start a temporary instance with isolated `IRMIA_DATA_DIR` and port; install a local fixture containing one Skill, one Hook and one MCP declaration through real HTTP; confirm and enable it; restart; verify all three contributions without eager MCP startup. Verify config MCP hot reload retains the plugin, three systemic failures quarantine it, and a later successful half-open probe restores it. Record any unverified external-model dependency plainly rather than claiming it was tested.
