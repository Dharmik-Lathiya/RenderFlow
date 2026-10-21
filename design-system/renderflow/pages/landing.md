# RenderFlow — Landing Page Definition

> **Project:** RenderFlow
> **Route:** `/` (public, no application shell)
> **Owner:** `apps/web`
> **Design source:** UI UX Pro Max design-system generation (`Hero + Features + CTA`,
> trust blue + warm CTA, Calistoga/Inter), adapted to the product's real
> capabilities and the repository's honesty rules.
> **Master:** `design-system/renderflow/MASTER.md`

---

## 1. Objective

Turn a first-time visitor into a registered account.

| Priority  | Action               | Destination     | Notes                                       |
| --------- | -------------------- | --------------- | ------------------------------------------- |
| Primary   | **Start free**       | `/register`     | Repeated in the header, hero and final CTA. |
| Secondary | **Sign in**          | `/login`        | Header and footer.                          |
| Tertiary  | **See how it works** | `#how-it-works` | Anchor; no JavaScript required.             |

The page must be useful with JavaScript disabled and must not require an account
to read.

## 2. Audience and message

**Audience:** solo founders and small marketing teams who have a brand and a goal
but no time to produce a month of content by hand.

**Message hierarchy**

1. **H1 — A month of marketing. Made in an afternoon.**
2. **Subhead —** RenderFlow turns one brand brief into captions, posters,
   carousels and reels, then schedules the approved ones. Pay per asset, not per
   seat; failed generations are refunded.
3. **Proof points —** free credits to start, no card required, refunds on system
   failure, retries cannot double-post.
4. **Product preview —** a real-looking studio board (campaign, generated
   caption, asset chips, calendar slots, credit ledger) rendered in HTML/CSS.

**Honesty constraints**

- No invented customer logos, testimonials, ratings or performance numbers.
- The preview is labelled as sample data.
- Do not claim live publishing to a specific network. Real adapters are
  provider-dependent and mock providers are the default in this repository.
- Do not print a credit amount or price. Both come from server configuration
  (`SIGNUP_BONUS_CREDITS`, `pricing_rules`); the page says "free credits" and
  "priced per asset".

## 3. Page structure

1. **Header (sticky, solid)** — wordmark, `Features`, `How it works`, `FAQ`,
   `Sign in`, primary `Start free`.
2. **Hero** — eyebrow, H1, subhead, CTA row, three proof points; product preview
   in a bordered frame with a "Preview · sample data" caption.
3. **Trust strip** — three facts: refund on failure, idempotent publishing,
   encrypted social tokens. Inline SVG icons, no emoji.
4. **Features** (bento, `#features`) — five cards:
   brief → campaign; drag-and-keyboard calendar; auditable credits; publishing
   that survives retries; analytics with a suggested next post.
5. **How it works** (`#how-it-works`) — three numbered steps: brief → generate
   and approve → schedule and publish.
6. **Quote band** (dark navy) — the reliability thesis from the project brief:
   “A crash at any point must never lose a job, double charge, or double post.”
7. **FAQ** (`#faq`) — native `<details>` items: card requirement, failed
   generations, channels, brand assets, pricing model.
8. **Final CTA** — blue panel, “Your next campaign is one brief away.”, primary
   orange `Start free`.
9. **Footer** — wordmark, one-line description, real links only, year.

## 4. Layout and responsive rules

- Content width: `1200px` maximum, `24px` gutters (`20px` below 480px).
- Hero: two columns from `960px` (`1.05fr / 0.95fr`), stacked below.
- Features: 6-column bento above `960px`; two columns from `640px`; one below.
- Header navigation links hide below `760px`; `Sign in` + `Start free` remain.
- How-it-works and FAQ collapse to one column below `800px`.
- All interactive targets are at least `44 × 44px`.
- No fixed-width containers; the preview frame shrinks with `min-width: 0`.
- No horizontal scrolling at `375px`; long words wrap.

## 5. Design tokens (landing-scoped)

The application is dark-first; the marketing page is a **light editorial
surface** so it reads as a public site, not a logged-in screen. Tokens are scoped
to `.landing` and do not leak into the app.

| Token             | Value     | Use                            |
| ----------------- | --------- | ------------------------------ |
| `--lp-bg`         | `#f8fafc` | page background                |
| `--lp-surface`    | `#ffffff` | cards, header                  |
| `--lp-surface-2`  | `#f1f5f9` | inset panels, chips            |
| `--lp-ink`        | `#0f172a` | headings and body              |
| `--lp-muted`      | `#475569` | secondary copy                 |
| `--lp-border`     | `#e2e8f0` | hairlines                      |
| `--lp-blue`       | `#2563eb` | links, focus ring, final panel |
| `--lp-blue-ink`   | `#1d4ed8` | link hover                     |
| `--lp-orange`     | `#ea580c` | primary CTA fill               |
| `--lp-orange-ink` | `#241003` | text on orange                 |
| `--lp-navy`       | `#0f172a` | quote band                     |
| `--lp-green`      | `#15803d` | positive checks (icons only)   |

Contrast (verified with WCAG relative luminance):

- ink on background: **17.06:1**
- muted on background: **7.24:1**
- white on blue: **5.17:1**
- orange-ink on orange: **5.13:1**
- white on navy: **17.85:1**
- orange icons on light background: **3.40:1** (non-text UI, passes 3:1)

### Typography

- Display: **Calistoga** (Google Fonts, self-hosted through `next/font`).
- Body/UI: **Inter** (Google Fonts, self-hosted through `next/font`).
- H1: `clamp(2.75rem, 7vw, 5rem)`, line-height `0.98`, tracking `-0.03em`.
- H2: `clamp(2rem, 4vw, 3rem)`, line-height `1.05`.
- Body: `1.0625rem`/`1.65`; small: `0.875rem`; eyebrow: `0.75rem` uppercase.
- Fonts are loaded on the server component with `display: 'swap'`; the fallback
  stack is Georgia/system sans so first paint is never invisible.

## 6. Interaction and motion

- Hero copy and preview enter with a `12px` rise + fade over `400ms`
  (`ease-out`), staggered by `80ms`.
- Hover/focus transitions are `160–200ms` and move at most `1px`.
- No autoplay, carousel, parallax, scroll-jacking or glassmorphism.
- `prefers-reduced-motion: reduce` removes all entrance motion and renders the
  final state immediately.
- FAQ uses native `<details>`; no client JavaScript.

## 7. Accessibility

- One `<h1>`; sections use `<h2>`/`<h3>` in order.
- Landmarks: `<header>`, `<main id="main">`, `<footer>`; the existing skip link
  targets `#main`.
- The product preview is a single `role="img"` with a descriptive
  `aria-label`; every decorative layer inside is `aria-hidden`.
- Icons are inline SVG with `aria-hidden="true"`; no emoji as icons.
- Focus ring: `3px solid var(--lp-blue)` with `2px` offset; never removed.
- Link text is descriptive; no “click here”.
- Text reflows at `375px` and at `200%` zoom; no fixed heights on copy blocks.
- FAQ summaries are keyboard-operable by default.

## 8. Implementation map

| Piece                    | File                                              |
| ------------------------ | ------------------------------------------------- |
| Route + metadata + fonts | `apps/web/src/app/page.tsx`                       |
| Page markup              | `apps/web/src/app/landing.tsx`                    |
| Styles                   | `apps/web/src/app/landing.module.css`             |
| Tests                    | `apps/web/src/app/landing.spec.tsx`               |
| Shell bypass             | `apps/web/src/components/shell.tsx` (`/` is bare) |

## 9. Acceptance criteria

- [ ] `GET /` returns `200` without a session and renders no application sidebar.
- [ ] `Start free` links to `/register`; `Sign in` links to `/login`; anchor
      links resolve to existing section ids.
- [ ] The page works with JavaScript disabled (server-rendered, native FAQ).
- [ ] No fake logos, testimonials, ratings or customer metrics.
- [ ] No hardcoded credit amount or price.
- [ ] jsdom test covers headings, CTA destinations, FAQ semantics and preview
      labelling.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- [ ] Responsive at 375/768/1024/1440 px by construction (no browser available
      here, so layout is reviewed in code, not screenshots).
