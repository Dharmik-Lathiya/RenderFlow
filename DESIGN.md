# RenderFlow Design System

> Direction: **Ember & Ink**. A warm coral-orange accent on near-black ink for the app, warm paper for public marketing pages. Creative enough for a marketing studio, serious enough for a product that handles credits and publishing.

This file is the source of truth for color, type, spacing and component behaviour. If code and this file disagree, fix one of them in the same PR.

---

## 1. Principles

1. **Trustworthy before pretty.** Credits, refunds and publishing are money-adjacent. Numbers are monospaced, states are explicit, and nothing looks like an error unless it is one.
2. **One accent.** Ember orange is for the primary action and active state only. If everything is orange, nothing is.
3. **Status is never color alone.** Every status pairs a color with a label or icon (WCAG 1.4.1).
4. **Tokens, not literals.** No hex values in components. Everything comes from CSS variables so themes stay swappable.
5. **Dark is the app default; light is the marketing default.** Both are first-class and contrast-checked.

---

## 2. Color

### 2.1 Core tokens

| Token                    | CSS variable           | Dark (app) | Light (marketing) |
| ------------------------ | ---------------------- | ---------- | ----------------- |
| Background               | `--background`         | `#0E0F13`  | `#FAF7F2`         |
| Surface (cards)          | `--card`               | `#16181E`  | `#FFFFFF`         |
| Surface 2 (hover, wells) | `--muted`              | `#1E2128`  | `#F1ECE3`         |
| Border                   | `--border`             | `#2A2E37`  | `#E4DDD0`         |
| Text                     | `--foreground`         | `#F2F3F5`  | `#1A1714`         |
| Muted text               | `--muted-foreground`   | `#9AA0AC`  | `#6B645B`         |
| **Accent**               | `--primary`            | `#FF6B3D`  | `#C93C12`         |
| Text on accent           | `--primary-foreground` | `#14110F`  | `#FFFFFF`         |
| Secondary accent         | `--secondary`          | `#7C8CFF`  | `#2F3F9E`         |

White text on the bright dark-mode orange is too low in contrast, so the button label is dark there. Do not "fix" it to white.

### 2.2 Semantic tokens

| Meaning                | Variable    | Hex (both themes)                    |
| ---------------------- | ----------- | ------------------------------------ |
| Success                | `--success` | `#2FB67C`                            |
| Warning                | `--warning` | `#F5A524`                            |
| Danger                 | `--danger`  | `#E5484D`                            |
| Info / in progress     | `--info`    | `#7C8CFF` (dark) / `#2F3F9E` (light) |
| Teal (ready, refunded) | `--teal`    | `#14B8A6`                            |
| Neutral (draft)        | `--neutral` | `#8B919C`                            |

`#14B8A6` and `#8B919C` are suggested values; adjust if brand review disagrees, then re-run the contrast table.

### 2.3 Post status mapping

| Status       | Color token | Treatment                    |
| ------------ | ----------- | ---------------------------- |
| `DRAFT`      | `--neutral` | Outlined badge               |
| `GENERATING` | `--info`    | Filled badge, animated pulse |
| `READY`      | `--teal`    | Filled badge                 |
| `APPROVED`   | `--success` | Filled badge                 |
| `SCHEDULED`  | `--warning` | Filled badge with clock icon |
| `PUBLISHING` | `--info`    | Filled badge, animated pulse |
| `PUBLISHED`  | `--success` | Filled badge with check icon |
| `FAILED`     | `--danger`  | Filled badge with alert icon |

### 2.4 Credit state mapping

| State            | Color                | Rule                                                         |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| Available        | `--foreground`       | Normal text; this is the headline number                     |
| Reserved         | `--warning`          | Credits held by an in-flight job                             |
| Refunded         | `--teal`             | **Never red.** A refund is the system working, not a failure |
| Spent (captured) | `--muted-foreground` | Historical, de-emphasised                                    |

Red (`--danger`) is reserved for real errors: failed jobs, expired tokens, validation failures.

### 2.5 Contrast (WCAG 2.1, computed)

Targets: 4.5:1 for body text, 3:1 for large text and UI components.

| Pair                                          | Ratio                     | Result                              |
| --------------------------------------------- | ------------------------- | ----------------------------------- |
| Dark: text on background                      | 17.25                     | Pass                                |
| Dark: muted text on background                | 7.29                      | Pass                                |
| Dark: muted text on card                      | 6.76                      | Pass                                |
| Dark: accent on background                    | 6.77                      | Pass                                |
| Dark: text-on-accent on accent                | 6.65                      | Pass                                |
| Dark: secondary on background                 | 6.43                      | Pass                                |
| Light: text on background                     | 16.70                     | Pass                                |
| Light: muted text on background               | 5.46                      | Pass                                |
| Light: accent on background                   | 4.75                      | Pass                                |
| Light: white on accent                        | 5.07                      | Pass                                |
| Light: secondary on background                | 8.45                      | Pass                                |
| Success / Warning / Teal / Neutral on dark bg | 7.39 / 9.39 / 7.69 / 6.05 | Pass                                |
| Danger on dark bg                             | 4.89                      | Pass (close; do not darken further) |

Status colors on the **light** theme have not been measured. Check them before using them as text on paper.

---

## 3. Typography

All fonts load through `next/font` (self-hosted, no layout shift). Maximum **two weights per family**.

| Role      | Font                           | Alternative      | Used for                                                             |
| --------- | ------------------------------ | ---------------- | -------------------------------------------------------------------- |
| UI / body | **Geist**                      | Inter            | Dashboard, forms, editor, tables                                     |
| Display   | **Bricolage Grotesque** (bold) | Instrument Serif | Landing and pricing headlines only                                   |
| Mono      | **Geist Mono**                 | JetBrains Mono   | Credit amounts, job IDs, ledger rows, SSE progress, idempotency keys |

### 3.1 Type scale

| Style                     | Size / line height             | Weight | Font    |
| ------------------------- | ------------------------------ | ------ | ------- |
| Display XL (landing hero) | 56 / 60 px (40 / 44 on mobile) | 700    | Display |
| Display L                 | 40 / 44 px                     | 700    | Display |
| H1 (page title)           | 28 / 34 px                     | 600    | UI      |
| H2 (section)              | 22 / 28 px                     | 600    | UI      |
| H3 (card title)           | 18 / 24 px                     | 600    | UI      |
| Body                      | 15 / 24 px                     | 400    | UI      |
| Small / caption           | 13 / 20 px                     | 400    | UI      |
| Label                     | 13 / 16 px                     | 500    | UI      |
| Mono number (balance)     | 32 / 36 px                     | 600    | Mono    |
| Mono inline (IDs, ledger) | 13 / 20 px                     | 400    | Mono    |

Rules:

- Display font appears only on public marketing pages. The app shell uses UI font throughout.
- Use `font-variant-numeric: tabular-nums` on every number that sits in a column.
- Never go below 13 px for readable text.
- Line length: 60-75 characters for prose.

---

## 4. Spacing, shape, elevation

| Token                               | Value                                   |
| ----------------------------------- | --------------------------------------- |
| Spacing base                        | 4 px grid: 4, 8, 12, 16, 24, 32, 48, 64 |
| Radius: small (inputs, badges)      | 6 px                                    |
| Radius: medium (buttons, cards)     | 10 px                                   |
| Radius: large (modals, hero panels) | 16 px                                   |
| Radius: full (avatars, pills)       | 9999 px                                 |
| Border                              | 1 px `--border`                         |
| Page max width (app)                | 1280 px                                 |
| Page max width (marketing prose)    | 720 px                                  |

Elevation:

- **Dark theme:** separate layers with surface color and border, not shadows.
- **Light theme:** one soft shadow for floating layers only (`0 8px 24px rgba(26, 23, 20, 0.08)`).

---

## 5. Components

### 5.1 Buttons

| Variant     | Use                                       | Style                                         |
| ----------- | ----------------------------------------- | --------------------------------------------- |
| Primary     | One per view: Generate, Approve, Schedule | `--primary` fill, `--primary-foreground` text |
| Secondary   | Supporting actions                        | `--muted` fill, `--foreground` text           |
| Outline     | Low-emphasis actions                      | Transparent, 1 px `--border`                  |
| Ghost       | Toolbar, table row actions                | Transparent, `--muted` on hover               |
| Destructive | Delete, disconnect account                | `--danger` fill or outline; always confirm    |

States: hover lightens/darkens 6%; `:focus-visible` shows a 2 px ring in `--primary` with 2 px offset; disabled is 50% opacity and `aria-disabled`. Buttons that cost credits show the price in a mono pill (e.g. `Generate reel · 30`).

### 5.2 Credit balance

The most important widget in the app.

- Available balance in Mono 32 px, with the label "Available" above.
- Reserved shown beneath in `--warning`, only when greater than 0.
- Pre-flight cost shown on every paid action before click, from the server estimate (never client-computed).
- Insufficient credits opens the upsell modal; the balance is left unchanged on screen.

### 5.3 Job progress (SSE)

- Horizontal stepper: PLAN, SCRIPT, IMAGE, VOICE, RENDER. Skip stages a job kind does not use (festival poster stops at IMAGE).
- Completed step: `--success` check. Active step: `--info` with pulse. Pending: `--neutral`.
- On failure: failed step in `--danger`, then a teal "Credits refunded" line.
- Reconnecting clients replay full history, so the UI must render from the event list, not from only the latest event.

### 5.4 Status badge

Pill, radius full, 12 px label, 500 weight, icon + text. Colors from section 2.3. Pulse animation only on `GENERATING` and `PUBLISHING`.

### 5.5 Cards and tables

- Card: `--card` background, 1 px border, radius medium, 16-24 px padding.
- Tables: sticky header, 44 px rows, hover row `--muted`, ledger amounts right-aligned in Mono. Credits leaving the user show a minus sign; refunds show a plus sign in `--teal`.
- Empty states: one sentence, one primary action, no illustration required.

### 5.6 Forms

- Label above input, always visible (no placeholder-only labels).
- Helper text in `--muted-foreground`; error text in `--danger` with an icon, linked via `aria-describedby`.
- Inputs: 40 px height, radius small, focus ring as buttons.

### 5.7 Calendar

- Posts appear as chips colored by platform-neutral status (section 2.3).
- Drag to reschedule, plus a date field on every card as the keyboard path.
- Today highlighted with an `--primary` outline, not a fill.

### 5.8 Notifications and toasts

- Success: `--success` icon, auto-dismiss 5 s.
- Error: `--danger`, persists until dismissed.
- Publish failure: persistent, with the account to reconnect named.

---

## 6. Motion

| Token                    | Value                                         |
| ------------------------ | --------------------------------------------- |
| Fast (hover, focus)      | 120 ms ease-out                               |
| Standard (menus, toasts) | 200 ms ease-out                               |
| Slow (modals, page)      | 320 ms cubic-bezier(0.2, 0, 0, 1)             |
| Pulse (active job)       | 1.6 s ease-in-out infinite, opacity 1 to 0.55 |

Respect `prefers-reduced-motion`: replace pulses and transitions with static states.

---

## 7. Accessibility

- Keyboard reachable everywhere; visible focus on every interactive element.
- Buttons activate on Enter and Space.
- Every input has a programmatic label; errors are associated with `aria-describedby`.
- Status conveyed by icon and text as well as color.
- File inputs stay in the tab order (visually hidden, not `display: none`).
- Touch targets at least 44 x 44 px on mobile.
- Test both themes; every palette change must keep the section 2.5 table passing.

---

## 8. Theming implementation

Dark is the default and follows the OS until the user picks a theme. The stored choice is applied by a `beforeInteractive` script that sets `data-theme` before first paint, so there is no flash.

```css
/* globals.css */
:root,
:root[data-theme='dark'] {
  --background: #0e0f13;
  --card: #16181e;
  --muted: #1e2128;
  --border: #2a2e37;
  --foreground: #f2f3f5;
  --muted-foreground: #9aa0ac;
  --primary: #ff6b3d;
  --primary-foreground: #14110f;
  --secondary: #7c8cff;
  --success: #2fb67c;
  --warning: #f5a524;
  --danger: #e5484d;
  --info: #7c8cff;
  --teal: #14b8a6;
  --neutral: #8b919c;
  --ring: #ff6b3d;
}

:root[data-theme='light'],
.marketing {
  --background: #faf7f2;
  --card: #ffffff;
  --muted: #f1ece3;
  --border: #e4ddd0;
  --foreground: #1a1714;
  --muted-foreground: #6b645b;
  --primary: #c93c12;
  --primary-foreground: #ffffff;
  --secondary: #2f3f9e;
  --info: #2f3f9e;
  --ring: #c93c12;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    /* same values as the light block above */
  }
}
```

```ts
// tailwind.config.ts (excerpt)
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        card: 'var(--card)',
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        border: 'var(--border)',
        foreground: 'var(--foreground)',
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: 'var(--secondary)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
        teal: 'var(--teal)',
        neutral: 'var(--neutral)',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        display: ['var(--font-display)', 'var(--font-geist-sans)', 'sans-serif'],
      },
      borderRadius: { sm: '6px', md: '10px', lg: '16px' },
    },
  },
};
```

```ts
// app/layout.tsx (excerpt)
import { Geist, Geist_Mono, Bricolage_Grotesque } from 'next/font/google';

const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
});
```

Note: marketing pages keep their own light editorial tokens, scoped with the `.marketing` class so they do not follow the app theme toggle.

---

## 9. Do and don't

| Do                                              | Don't                                                   |
| ----------------------------------------------- | ------------------------------------------------------- |
| Use `--primary` for one main action per view    | Use orange for decoration or multiple competing buttons |
| Show refunds in teal                            | Show refunds in red                                     |
| Put credit numbers in Mono with tabular figures | Mix proportional fonts in balance columns               |
| Pair color with icon and label                  | Rely on color alone for status                          |
| Reference tokens in components                  | Hard-code hex values                                    |
| Use Display font on marketing headlines         | Use Display font inside the app shell                   |

---

## 10. Review checklist

- [ ] No raw hex values outside `globals.css`
- [ ] Both themes checked, contrast table still passes
- [ ] Every status has icon + text
- [ ] Focus ring visible on all controls
- [ ] Paid actions show server-estimated cost before click
- [ ] Reduced-motion fallback present
- [ ] Mobile viewport (Pixel 7 size) checked
