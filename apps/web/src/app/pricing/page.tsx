import type { Metadata } from 'next';
import Link from 'next/link';

import { MarketingPage } from '../../components/marketing';
import { describeAction, fetchPricing } from '../../lib/pricing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

/**
 * Public pricing.
 *
 * The numbers come from the API, not from this file. `pricing_rules` is the only
 * place a price lives (AGENTS.md rule 7), and a page that quotes its own table is
 * a second source of truth that goes stale silently.
 *
 * `force-dynamic` because the page reads the API at request time: prerendering it
 * during `next build` would either bake in whatever the build machine could reach
 * or fail the build when the API is not up, and neither is acceptable for a page
 * that must always tell the truth about a price.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Pricing — RenderFlow',
  description:
    'Pay per asset, not per seat. Captions, posters, carousels and reels each have a credit price, scheduling is free, and failed generations are refunded.',
};

export default async function PricingPage() {
  const pricing = await fetchPricing();
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@renderflow.example';

  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={`${styles.page} ${styles.wide}`}>
        <p className={styles.eyebrow}>Pricing</p>
        <h1 className={styles.title}>Pay for the work, not the seats.</h1>
        <p className={styles.lede}>
          Every asset has a credit price set by the server, so the number you read here is the
          number the API charges. Scheduling and publishing are free. A generation that fails after
          retries is refunded automatically.
        </p>

        {pricing === null ? (
          <p className={styles.unavailable} role="status">
            Prices are temporarily unavailable while the pricing service restarts. Your balance is
            never charged without a price from the server — please try again in a moment.
          </p>
        ) : (
          <>
            <p className={styles.note}>
              New accounts start with <strong>{pricing.signupBonus} credits</strong> — enough to try
              a plan and a few assets before deciding anything. No card is required to create an
              account.
            </p>

            <ul className={styles.priceList} aria-label="Credit prices per asset">
              {pricing.prices.map((quote) => {
                const { label, hint } = describeAction(quote.action);
                return (
                  <li key={quote.action} className={styles.priceRow}>
                    <span>
                      <span className={styles.priceLabel}>{label}</span>
                      {hint === undefined ? null : <span className={styles.priceHint}>{hint}</span>}
                    </span>
                    <span className={styles.priceValue}>
                      {quote.credits === 0 ? (
                        <span className={styles.free}>Free</span>
                      ) : (
                        `${quote.credits} credits`
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className={styles.actions}>
          <Link className={styles.primary} href="/register">
            Start free
          </Link>
          <Link className={styles.secondary} href="/contact">
            Ask about credits
          </Link>
        </div>

        <div className={styles.prose}>
          <h2>What is free</h2>
          <ul>
            <li>Scheduling and publishing to a connected account.</li>
            <li>The calendar, the approval workflow and analytics.</li>
            <li>Failed generations: the reservation is returned, so a failure costs nothing.</li>
          </ul>

          <h2>Buying more credits</h2>
          <p>
            This deployment does not sell credit packs in the app yet. If you need a larger balance,
            write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we will set it up
            directly. When card payments are enabled, purchases will appear in the ledger as their
            own entry — the same ledger every generation is charged against.
          </p>

          <h2>Why credits at all</h2>
          <p>
            Generation is the expensive part: a language model call, an image, a voice track and a
            render. Credits make that cost visible before the work starts, and reserving them means
            two clicks on the same button cannot spend the same balance twice.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
