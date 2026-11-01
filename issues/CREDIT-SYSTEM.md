# Credit System — Festival Marketing Feature

How the existing RenderFlow credit engine applies to the Festival Marketing
Template Generator. No changes to the credit engine itself — this document
explains the mapping and the pricing decisions.

---

## 1. How the existing credit engine works (recap)

Every new user gets **50 free credits** at signup (configured via `SIGNUP_BONUS_CREDITS`).

The wallet has two buckets:

```
available  — credits the user can spend
reserved   — credits held while a job is running
```

The lifecycle for any generation job:

```
1. User clicks Generate
   → API checks: available >= cost?
   → If no:  return 402 INSUFFICIENT_CREDITS, create nothing
   → If yes: available -= cost, reserved += cost (one DB transaction)

2. Job runs through stages in workers

3. Job succeeds:
   → reserved -= cost (CAPTURE)
   → credits are permanently spent

4. Job fails (after retries exhausted):
   → reserved -= cost, available += cost (REFUND)
   → user gets their credits back
```

Every movement is an append-only row in `credit_ledger` with a unique
`(reference_type, reference_id, entry_type)` constraint — so reserve,
capture, and refund are all idempotent. A crash cannot double-charge.

Prices come from the `pricing_rules` table, never from client code.

---

## 2. Credit costs for Festival Marketing

New pricing rows to add to `pnpm db:seed`:

| Action                       | Credits | Notes                                                                                  |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Festival poster (image only) | **6**   | Template select (1) + copy fill (1) + image render (5) — but billed as one atomic cost |
| Festival poster + reel (15s) | **36**  | Poster cost (6) + reel (30) = 36                                                       |
| Festival caption only        | **1**   | If user just wants copy, no image                                                      |

**Why these numbers:**

- They match the existing `pricing_rules` for equivalent work:
  - Caption + hashtags: 1 credit (existing)
  - Poster / photo: 5 credits (existing)
  - Reel ≤ 15s: 30 credits (existing)
- The `TEMPLATE_SELECT` stage is LLM-light (short prompt, fast) — bundled into
  the poster cost rather than billed separately. Avoids user confusion.
- Pricing is per output, not per stage — users understand "poster = 6 credits"
  better than "3 stages × N credits each".

---

## 3. How pricing is looked up

The API resolves the cost before reserving:

```typescript
// apps/api/src/modules/festival/festival.service.ts
async estimateCost(input: FestivalInput): Promise<number> {
  const posterCost = await this.credits.getPrice('FESTIVAL_POSTER');  // 6
  if (!input.includeReel) return posterCost;

  const reelCost = await this.credits.getPrice('FESTIVAL_REEL');      // 30
  return posterCost + reelCost;
}
```

`getPrice()` reads from `pricing_rules`. If a row is missing, it throws
`PRICE_NOT_FOUND` and the API returns 500 — this is intentional, same as the
existing behaviour. A missing price is a configuration error, not a free ride.

The `pricing_rules` keys for the festival feature:

```
FESTIVAL_POSTER   = 6
FESTIVAL_REEL     = 30
```

These are added to `pnpm db:seed` alongside the existing rules.

---

## 4. Credit flow walkthrough — poster only (6 credits)

User has 50 credits (fresh signup). They generate a Diwali poster.

```
Step 1 — Reserve
  available: 50 → 44
  reserved:   0 → 6
  ledger row: { type: RESERVE, amount: -6, reference: job-uuid, entry: RESERVE }

Step 2 — TEMPLATE_SELECT stage completes
  No credit movement. Checkpoint saved.

Step 3 — COPY_FILL stage completes
  No credit movement. Checkpoint saved.

Step 4 — IMAGE_RENDER stage completes
  No credit movement. Checkpoint saved.

Step 5 — Job DONE → Capture
  available: 44  (unchanged)
  reserved:   6 → 0
  ledger row: { type: CAPTURE, amount: -6, reference: job-uuid, entry: CAPTURE }
  Wallet:     available=44, reserved=0
```

---

## 5. Credit flow walkthrough — IMAGE_RENDER fails, then refund

```
Step 1 — Reserve
  available: 50 → 44, reserved: 0 → 6

Step 2 — TEMPLATE_SELECT: ok
Step 3 — COPY_FILL: ok
Step 4 — IMAGE_RENDER: fails (provider error)
  Worker retries with exponential backoff (3 attempts by default)
  All retries fail → classify as PERMANENT or exhaust budget

Step 5 — Refund
  available: 44 → 50, reserved: 6 → 0
  ledger row: { type: REFUND, amount: +6, reference: job-uuid, entry: REFUND }
  Wallet:     available=50, reserved=0  (back to start)
```

The refund is idempotent — if the worker crashes after writing the refund ledger
row but before updating the wallet cache, the next run sees the unique constraint
and skips the duplicate insert. The wallet reconciliation detects any drift.

---

## 6. Credit flow walkthrough — poster + reel (36 credits)

```
Step 1 — Reserve
  cost = FESTIVAL_POSTER (6) + FESTIVAL_REEL (30) = 36
  available: 50 → 14, reserved: 0 → 36

Steps 2–5 — stages complete (TEMPLATE_SELECT, COPY_FILL, IMAGE_RENDER, REEL_RENDER)

Step 6 — Capture
  reserved: 36 → 0
  Wallet: available=14, reserved=0

If user has only 30 credits and tries poster + reel:
  → 402 INSUFFICIENT_CREDITS (30 < 36)
  → Nothing is created
  → User sees: "You need 36 credits. You have 30. Buy 10 more credits."
```

---

## 7. What if user cancels mid-generation?

There is no cancel endpoint in the current system. Credits stay reserved until:

- The job completes → capture
- The job exhausts retries → refund
- The reaper finds an expired lease → requeues the job

This is consistent with how all other job kinds work. Adding a cancel endpoint
is a future improvement (tracked separately).

---

## 8. Credit display in the UI

Before the user clicks Generate, the festival form shows:

```
┌─────────────────────────────────────────────┐
│  Cost estimate                              │
│                                             │
│  ✓ Festival poster         6 credits        │
│  ✓ 15s reel               30 credits        │
│  ─────────────────────────────────────      │
│  Total                    36 credits        │
│                                             │
│  Your balance: 50 credits                  │
│  After generation: 14 credits              │
│                                             │
│  [ Generate — 36 credits ]                 │
└─────────────────────────────────────────────┘
```

The balance is read from `GET /api/v1/credits/balance`. The estimate is read
from `GET /api/v1/festival/estimate?includeReel=true`. Both are real API calls,
not client-side calculations — the client never owns pricing logic.

---

## 9. New pricing_rules rows

Add to `libs/db/src/seed.ts` (alongside existing rows):

```typescript
{ action: 'FESTIVAL_POSTER', credits: 6,  description: 'Festival marketing poster (template + AI copy + image render)' },
{ action: 'FESTIVAL_REEL',   credits: 30, description: 'Festival marketing reel 15s (FFmpeg render on top of poster)' },
```

---

## 10. Why the credit rules stay simple

The festival feature adds new `action` types to `pricing_rules` but does not
change the credit engine at all. The engine is already designed for this:

- `reserve()` takes an action name → looks up cost → reserves
- `capture()` / `refund()` use the reserved amount → no re-lookup needed
- Idempotency is already guaranteed by the unique constraint on ledger rows

This is the payoff of building the credit engine as a pure, generic ledger
rather than hardcoding per-feature logic.
