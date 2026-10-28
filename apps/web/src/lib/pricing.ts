/**
 * Server-side pricing for the public page.
 *
 * The markup must not restate the prices: `pricing_rules` is the only place a
 * price lives (AGENTS.md rule 7), and a marketing page that quotes its own table
 * is a second source of truth that goes stale silently. So the page is rendered
 * from this fetch, and a failed fetch renders "unavailable" rather than an old
 * number.
 *
 * `API_INTERNAL_URL` exists because the browser-facing `NEXT_PUBLIC_API_URL` is
 * `http://localhost:4000` in compose, which inside the web container is the web
 * container itself. Server-side reads need the service address.
 */

export interface PriceQuote {
  action: string;
  credits: number;
}

export interface Pricing {
  signupBonus: number;
  prices: PriceQuote[];
}

const FALLBACK_API = 'http://localhost:4000/api/v1';

/** Long enough for a warm server, short enough that a hung API cannot hold a page. */
const REQUEST_TIMEOUT_MS = 3_000;

function apiBase(): string {
  const raw = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? FALLBACK_API;
  return raw.replace(/\/+$/, '');
}

function isPriceQuote(value: unknown): value is PriceQuote {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { action?: unknown; credits?: unknown };
  return typeof candidate.action === 'string' && Number.isInteger(candidate.credits);
}

/**
 * Returns `null` rather than throwing: a marketing page that 500s because the API
 * is restarting is worse than one that says prices are temporarily unavailable.
 * Nothing is cached - the response header already allows a 60s cache upstream.
 */
export async function fetchPricing(): Promise<Pricing | null> {
  // An explicit controller rather than `AbortSignal.timeout`: that helper leaves
  // its timer pending until it fires, so every render held a live handle for the
  // full timeout even when the request had already returned.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(`${apiBase()}/credits/pricing`, {
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }

    const { signupBonus, prices } = body as { signupBonus?: unknown; prices?: unknown };
    if (!Number.isInteger(signupBonus) || !Array.isArray(prices)) {
      return null;
    }

    return {
      signupBonus: signupBonus as number,
      prices: prices.filter(isPriceQuote),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Human labels for generation kinds.
 *
 * The API returns the enum, not prose, because prose is presentation. An action
 * with no label here still renders - under its raw kind - so adding a priced
 * action never renders an empty row.
 */
const LABELS: Readonly<Record<string, { label: string; hint?: string }>> = {
  CONTENT_PLAN: { label: '7-day content plan', hint: 'Goal in, dated posts out' },
  CAPTION: { label: 'Caption + hashtags', hint: 'One post, in the brand voice' },
  POSTER: { label: 'Poster / photo', hint: 'One image' },
  CAROUSEL: { label: 'Carousel', hint: 'Up to five images' },
  REEL: { label: 'Reel / video', hint: 'Up to 30 seconds, with narration' },
  REGENERATE_SCENE: { label: 'Regenerate one scene', hint: 'Redo a single shot' },
  TRANSLATION: { label: 'Caption translation', hint: 'One target language' },
};

export function describeAction(action: string): { label: string; hint?: string } {
  return LABELS[action] ?? { label: action };
}
