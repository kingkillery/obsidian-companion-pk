# Obsidian Companion to 100% Production-Ready Plan (Execution Version)

## Summary
This plan moves the plugin from current state to production-ready by finishing three high-value tracks:
1) completion telemetry + acceptance reliability, 2) slash/@ command execution parity and determinism, 3) repeatable validation and release gating.

## Current Position
- Completion path has hardening and fallback logic already in place, but no strict accepted/rejected outcome telemetry contract.
- `/` and `@` flows are implemented, but command execution failure modes are not standardized.
- There are two smoke scripts, but no single “production gate” that enforces build + reload + smoke checks.

## Track 1: Completion reliability with deterministic status
### Goal
Add deterministic completion outcome telemetry and user-visible failure paths so every completion attempt can be classified as running/suggested/accepted/missing/error.

### Required file changes
- `src/cache.ts`
- `src/main.tsx`
- `src/complete/completers/openrouter/openrouter.tsx`

### Implementation
- Add window-exposed telemetry object in `src/main.tsx`:
  - `window.__companion_last_completion_result`
  - status: `running | suggested | accepted | missing_suggestion | error | idle`
  - include provider/model/timestamp/errorCode/errorMessage/suggestionLen/elapsedMs
- In `src/cache.ts`:
  - emit `running` at fetch start and provider/model context
  - emit `error` on fetch failure with stable error codes/messages
  - emit `suggested` when at least one suggestion is yielded
  - emit `missing_suggestion` when fetch completes without usable tokens
- In `src/main.tsx`:
  - emit `accepted` from `acceptCompletion` with insertion delta and fallback notices for no suggestion/error
  - emit useful notices when insertion fails
- In `src/complete/completers/openrouter/openrouter.tsx`:
  - ensure completion attempts include attempt metadata in debug payload (`primary` vs `rescue`)
  - ensure fallback attempts are visible if primary completion is unusable

### Acceptance criteria
- completion failure paths produce explicit status and non-empty error reason
- completion acceptance path sets `accepted` only on actual document mutation
- openrouter fallback attempt is visible in payload debug data

## Track 2: `/` + `@` command parity and deterministic execution
### Goal
Make command execution safe and deterministic, with explicit success/failure return and status outputs.

### Required file changes
- `src/commands/SlashCommandService.ts`
- `src/main.tsx`
- `src/commands/SlashCommandModal.ts`

### Implementation
- Change command executor contract to return `Promise<boolean>` for explicit success/failure.
- Add `window.__companion_last_slash_command_result` with:
  - trigger/query/command id + result + reason + file/path state
- For `@open` and `@link`:
  - verify target existence, report failure when missing
  - ensure link insertion/open result is confirmed
- In modal wiring in `src/main.tsx`:
  - close modal only when execution succeeds
  - keep it open and surface error on failed execution
- Keep `@`/`/` trigger-aware behavior and stale-request-safe modal refresh behavior

### Acceptance criteria
- `@open` and `@link` return false with explicit reason when lookup fails
- successful execution returns true and can be observed in global status
- failed execution does not silently disappear

## Track 3: Deterministic production gate
### Goal
Create one command (`npm run release:check`) that enforces build + plugin copy + smoke verification.

### Required file changes
- `package.json`
- `scripts/electron-smoke.cjs`
- `scripts/electron-completion-accept-check.cjs`
- `scripts/production-gate.mjs` (new)
- `scripts/copy-plugin-to-vault.mjs` (new)

### Implementation
- Add `scripts/production-gate.mjs` that:
  - runs `npm run build`
  - runs plugin copy step and validates file hashes
  - runs completion and slash smoke scripts
  - writes machine-readable artifact summary under `artifacts/production-gate-<timestamp>.json`
- Add `scripts/copy-plugin-to-vault.mjs`:
  - copies `main.js`, `manifest.json`, `styles.css`
  - verifies output file hashes
- Update package scripts to include:
  - `smoke`, `release:check`
  - optional helper targets for each smoke script
- Update smoke scripts to expose completion/slash status in output for gating
- Make copy step multi-vault aware:
  - support repeated `--vault` and `--vaults` arguments (comma/semicolon-delimited)
  - support env vars `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_VAULT_PATHS`
  - forward vault selectors through `npm run release:check -- ...` to the copy script
- gate completion requires all targeted vault copies to succeed with matching hashes

### Acceptance criteria
- `npm run release:check` exits non-zero on any hard failure
- all artifacts and statuses are persisted; multi-vault copy artifacts include `vault_count` and per-vault results
- gate success requires both:
  - completion accepted (or equivalent successful acceptance signal)
  - slash smoke success for `@open` and `@link`

## Execution order
1. Implement Track 1 files.
2. Implement Track 2 files.
3. Implement Track 3 scripts and wiring.
4. Run `npm run release:check` once with a correctly configured vault path.
