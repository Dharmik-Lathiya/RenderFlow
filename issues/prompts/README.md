# Agent prompts — how to run the implementation

Copy-paste prompts for implementing `issues/SECURITY-ISSUES.md`,
`issues/ARCHITECTURE-GAPS.md`, `issues/FESTIVAL-MARKETING.md`,
`issues/CREDIT-SYSTEM.md`, and `issues/DEPLOYMENT-DEMO.md`.

The prompts are written for **any** coding agent (Claude Code, Codex, Cursor,
OpenCode, etc.). They work in two modes:

- **Orchestrator + subagents** — one lead agent owns the loop, spawns one
  implementer per task, and uses an independent reviewer.
- **Single-agent loop** — the same lead prompt, but it does each task itself,
  one task per iteration, committing after each.

---

## Verified baseline — 2026-11-01

All six design files exist and are complete:

| File                    | Size         |
| ----------------------- | ------------ |
| `SECURITY-ISSUES.md`    | 11,152 bytes |
| `ARCHITECTURE-GAPS.md`  | 13,239 bytes |
| `FESTIVAL-MARKETING.md` | 12,390 bytes |
| `CREDIT-SYSTEM.md`      | 7,717 bytes  |
| `DEPLOYMENT-DEMO.md`    | 10,829 bytes |
| `README.md`             | 1,876 bytes  |

**The repository is dirty. Do not reset it.** At verification time there were
41 working-tree entries: a staged web redesign, unstaged changes to
`libs/db/src/schema.ts`, `apps/reaper/src/main.ts`, `.env.example`, and
untracked `issues/`, `railway.toml`, `scripts/seed-demo.mjs`,
`scripts/pre-deploy-check.sh`.

**The design docs are intent, not literal file paths.** Verified drift:

| Design doc says                                          | Actual code                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/api/src/modules/health/health.service.ts`          | `apps/api/src/health/health.service.ts`                                             |
| `apps/api/src/modules/rate-limit/`                       | `apps/api/src/ratelimit/`                                                           |
| `apps/api/src/modules/festival/`                         | does not exist yet                                                                  |
| `apps/media-worker/src/handlers/*`                       | does not exist; stage logic is a `switch` in `libs/jobs/src/runner.ts`              |
| `StageHandler` interface                                 | no such interface; `runStage()` is a hard-coded switch                              |
| `libs/db/src/seed.ts`                                    | `libs/credits/scripts/seed.mjs`; prices in `libs/credits/src/pricing.ts`            |
| New stages `TEMPLATE_SELECT`, `COPY_FILL`, `REEL_RENDER` | `JOB_STAGES` is a fixed global list of 6; adding stages is a cross-cutting refactor |

State that is **partially done already**:

- `festival_occasions` and `festival_templates` are in `libs/db/src/schema.ts`,
  but **no migration contains them** (`libs/db/drizzle/0014_*.sql` is the last).
- The reaper already has the hot-spare poll loop in the working tree
  (`apps/reaper/src/main.ts`), but it is uncommitted and untested here.
- `.env.example` already mentions `RATE_LIMIT_STORE=memory` and
  `SEED_DEMO_ACCOUNT=false`; the API env schema does not implement them yet.
- `railway.toml`, `scripts/seed-demo.mjs`, and `scripts/pre-deploy-check.sh`
  exist but are untracked.

Every prompt below starts with an audit step for this reason.

---

## Files

| File                 | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `00-ORCHESTRATOR.md` | Lead agent / loop controller. Reads the task manifest, audits, dispatches, verifies, commits. |
| `TASKS.md`           | Task manifest: IDs, dependencies, ownership, parallel groups, done criteria.                  |
| `01-SECURITY.md`     | Security workstream (SEC-01 … SEC-12).                                                        |
| `02-ARCHITECTURE.md` | Reliability workstream (ARCH-02 … ARCH-09).                                                   |
| `03-FESTIVAL.md`     | Phase 11 festival feature (F1 … F7).                                                          |
| `04-DEPLOYMENT.md`   | Demo deployment artifacts and runbook (D1 … D4).                                              |
| `05-REVIEWER.md`     | Independent verifier. Must not be the implementer.                                            |

---

## Recommended order

1. **Baseline** — commit or isolate the current working tree; run
   `pnpm lint && pnpm typecheck && pnpm test`; record failures.
2. **Critical security** — SEC-01 (health), SEC-02 + SEC-03 (shared rate
   limiting and proxy trust), SEC-06 (refresh families).
3. **Production blockers** — ARCH-02 (worker metrics), ARCH-03 (Alertmanager),
   ARCH-05 (notifications consumer).
4. **Remaining security** — SEC-04, SEC-05, SEC-07 … SEC-12.
5. **Reliability** — ARCH-06, ARCH-08, ARCH-09; ARCH-07 is docs-only.
6. **Festival** — F1 → F2 → F3 → F4 → F5 → F6 → F7. This chain is serial.
7. **Deployment** — D1 → D2 → D3 → D4. Cloud side effects need explicit human
   authorization.
8. **Final review** — `05-REVIEWER.md` over the whole integration branch.

Do **not** run the festival stream and the security stream at the same time:
both touch `libs/common`, `libs/db`, and `apps/api/src/config/env.ts`.

---

## Mode A — orchestrator + subagents

Paste `00-ORCHESTRATOR.md` into the lead agent. Give it:

```
MODE=orchestrator
REPO=/absolute/path/to/RenderFlow
BASE_BRANCH=<current branch>
INTEGRATION_BRANCH=hardening/2026-11
MAX_PARALLEL=2
MAX_ATTEMPTS=3
```

It will read `TASKS.md`, dispatch one implementer per task using the stream
prompt, then dispatch `05-REVIEWER.md` on the diff. It must not review its own
work.

## Mode B — single-agent loop

Paste `00-ORCHESTRATOR.md` with:

```
MODE=single
...
```

The agent runs the same loop inline: pick task → implement → run gates →
commit → update state → next task. One task per commit. It must not batch
unrelated tasks into one change.

## Mode C — manual per-stream

Send one stream prompt (`01` … `04`) to one agent, and tell it which task ID to
do. Do not let it pick more than one task until the first is reviewed. This is
the slowest mode but the easiest to audit.

---

## Copy-paste invocation template

```
You are implementing task <ID> in the RenderFlow repository.

Read, in this order:
1. AGENTS.md
2. PROJECT.md — only the sections named in your stream prompt
3. issues/<STREAM-DOC>.md — only the section for <ID>
4. issues/prompts/<STREAM>.md — the task brief for <ID>
5. The actual files named in the task brief. Verify paths before editing.

Work only on <ID>. Do not refactor unrelated code. Do not reset, stash, clean,
or checkout over existing work. If the working tree is dirty, stop and report.

Return exactly:
STATUS: DONE | ALREADY_DONE | BLOCKED
FILES: <paths>
TESTS: <command → result>
COMMIT: <hash or "not committed">
RISKS: <one line each>
```

---

## Non-negotiable rules to repeat in every subagent prompt

- Only `libs/credits` writes to `wallets` or `credit_ledger`.
- Reserve/capture/refund are single DB transactions; no read-then-write.
- A job + reservation + outbox event are created in one transaction.
- No direct queue pushes from request handlers; use the outbox.
- Every worker handler is idempotent.
- Costs come from `pricing_rules`, never the client.
- New schema changes use a new Drizzle migration; never edit a merged migration.
- No real AI/social/email calls in tests; use the mocks.
- No secrets, no `console.log`, no `any`, no TODO without an issue reference.
- Run `pnpm lint && pnpm typecheck && pnpm test` before reporting done.
