# RenderFlow — Landing Page Definition

> **Project:** RenderFlow
> **Route:** `/` (public, no application shell)
> **Owner:** `apps/web`
> **Design source:** **Ember & Ink** (`DESIGN.md`), adapted to the product's real
> capabilities and the repository's honesty rules.
> **Master:** `DESIGN.md` (the generated `MASTER.md` is historical).

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
6. **Quote band** (ink panel with an ember wash) — the reliability thesis from
   the project brief: “A crash at any point must never lose a job, double charge,
   or double post.”
7. **FAQ** (`#faq`) — native `<details>` items: card requirement, failed
   generations, channels, brand assets, pricing model.
8. **Final CTA** — ink panel with ember glow, “Your next campaign is one brief
   away.”, bright ember `Start free`.
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
to `.landing` and do not leak into the app. They are the light-theme values from
`DESIGN.md` section 2.1; components reference tokens, never raw hex.

| Token                | Value     | Use                                |
| -------------------- | --------- | ---------------------------------- |
| `--lp-bg`            | `#faf7f2` | warm paper page background         |
| `--lp-surface`       | `#ffffff` | cards, header                      |
| `--lp-surface-2`     | `#f1ece3` | inset panels, chips                |
| `--lp-ink`           | `#1a1714` | headings and body                  |
| `--lp-muted`         | `#6b645b` | secondary copy                     |
| `--lp-border`        | `#e4ddd0` | hairlines                          |
| `--lp-border-strong` | `#cfc5b5` | hover borders                      |
| `--lp-accent`        | `#c93c12` | links, focus ring, primary CTA     |
| `--lp-accent-strong` | `#a9320e` | accent text on the warm background |
| `--lp-accent-ink`    | `#ffffff` | text on accent                     |
| `--lp-secondary`     | `#2f3f9e` | secondary links and info states    |
| `--lp-ink-panel`     | `#0e0f13` | quote band, final CTA              |
| `--lp-on-ink`        | `#f2f3f5` | text on ink panels                 |
| `--lp-muted-on-ink`  | `#9aa0ac` | secondary text on ink panels       |
| `--lp-warning`       | `#8a5b00` | scheduled / reserved credit states |
| `--lp-teal`          | `#0f766e` | READY state, refunds               |
| `--lp-success`       | `#16794f` | approved / published states        |
| `--lp-bright`        | `#ff6b3d` | bright ember CTA on dark panels    |
| `--lp-bright-ink`    | `#14110f` | text on the bright ember CTA       |

Contrast (verified with WCAG relative luminance):

- ink on background: **16.70:1**
- muted on background: **5.46:1**
- accent on background: **4.75:1**
- white on accent: **5.07:1**
- secondary on background: **8.45:1**
- warning on surface: **5.87:1**
- teal on surface: **5.47:1**
- success on surface: **5.41:1**
- bright-ink on bright: **6.65:1**
- on-ink on ink panel: **17.25:1**

### Typography

- Display: **Bricolage Grotesque**, weight `600–700` (self-hosted via `next/font`).
- Body/UI: **Geist**; numbers and IDs: **Geist Mono**.
- H1: `clamp(2.5rem, 4.6vw, 3.5rem)`, line-height `1.07`, tracking `-0.035em`.
- H2: `clamp(2rem, 3.6vw, 2.5rem)`, line-height `1.1`, weight `700`.
- Body: `1.0625rem`/`1.65`; small: `0.875rem`; eyebrow: `0.75rem` uppercase.
- Fonts are loaded on the server component with `display: 'swap'`; the fallback
  stack is system sans so first paint is never invisible.

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
- Focus ring: `2px solid var(--lp-accent)` with `2px` offset; never removed.
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
