import Link from 'next/link';
import type { ReactNode } from 'react';

import { ArrowRight, MarketingPage } from '../components/marketing';
import styles from './landing.module.css';

/**
 * The public landing page (§ UI UX Pro Max definition:
 * `design-system/renderflow/pages/landing.md`).
 *
 * A server component on purpose. There is no state to manage, the FAQ is native
 * `<details>`, and every link is a real route - so the page works with
 * JavaScript disabled and ships no client bundle of its own.
 */

const FAQ = [
  {
    question: 'Do I need a credit card to start?',
    answer:
      'No. Create an account and you get free credits to try the studio. Generation is priced per asset, so you can stop before spending anything you have not chosen to add.',
  },
  {
    question: 'What happens when a generation fails?',
    answer:
      'Credits are reserved before work starts and returned automatically when the system fails after retries. A failed job never costs credits, and every movement is written to an append-only ledger.',
  },
  {
    question: 'Which channels can I schedule?',
    answer:
      'The scheduler is built around a connected account, an approved post and a time. RenderFlow ships Instagram and LinkedIn workflows; which live networks a deployment enables depends on its provider configuration.',
  },
  {
    question: 'Can I keep my brand voice?',
    answer:
      'Yes. Every brand carries its own industry, colours, languages, tone and style. Generation uses that brief as context, and every caption, poster and scene can be edited before you approve it.',
  },
  {
    question: 'How does pricing work?',
    answer:
      'Generation is priced by the server, not by seat: captions, posters, carousels and reels each have a credit cost. Scheduling and publishing are free, and a system failure is refunded.',
  },
] as const;

export function Landing({ fontClassName }: { fontClassName?: string }) {
  return (
    <MarketingPage fontClassName={fontClassName}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span className={styles.eyebrowDot} aria-hidden="true" />
            AI marketing studio for small teams
          </p>

          <h1 id="hero-title" className={styles.heroTitle}>
            A month of marketing.
            <span className={styles.heroTitleAccent}>Made in an afternoon.</span>
          </h1>

          <p className={styles.heroLede}>
            RenderFlow turns one brand brief into captions, posters, carousels and reels, then
            schedules the approved ones. Pay per asset, not per seat — and failed generations are
            refunded.
          </p>

          <div className={styles.heroActions}>
            <Link className={styles.primaryCta} href="/register">
              Start free
              <ArrowRight className={styles.ctaArrow} />
            </Link>
            <a className={styles.secondaryCta} href="#how-it-works">
              See how it works
            </a>
          </div>

          <ul className={styles.proofRow}>
            <li>
              <CheckIcon className={styles.check} />
              Free credits to start
            </li>
            <li>
              <CheckIcon className={styles.check} />
              No card required
            </li>
            <li>
              <CheckIcon className={styles.check} />
              Refunds on system failure
            </li>
          </ul>
        </div>

        <Preview />
      </section>

      <section className={styles.trust} aria-label="How RenderFlow protects your work">
        <div className={styles.trustInner}>
          <TrustItem
            icon={<ShieldIcon />}
            title="Refund on failure"
            body="If generation fails after retries, the reserved credits go back automatically."
          />
          <TrustItem
            icon={<RepeatIcon />}
            title="No double posts"
            body="Publishing checks for the existing platform post before any retry is allowed."
          />
          <TrustItem
            icon={<KeyIcon />}
            title="Tokens encrypted"
            body="Social credentials are encrypted at rest with AES-256-GCM and never returned."
          />
        </div>
      </section>

      <section id="features" className={styles.section} aria-labelledby="features-title">
        <div className={styles.sectionHead}>
          <p className={styles.eyebrow}>One studio, end to end</p>
          <h2 id="features-title" className={styles.sectionTitle}>
            From brief to published, without the handoffs.
          </h2>
          <p className={styles.sectionLede}>
            The same system writes the campaign, keeps the calendar honest, and makes sure a retry
            cannot charge you twice. The parts that usually break are the parts we built first.
          </p>
        </div>

        <div className={styles.features}>
          <Feature icon={<SparkIcon />} title="Brief in. Campaign out." wide>
            <p>
              Describe the brand and the goal. RenderFlow plans the campaign and drafts the assets
              in your voice — first as a structured plan, then as finished work.
            </p>
            <div className={styles.featureVisual}>
              <div className={styles.chipRow}>
                <span className={styles.chip}>Caption</span>
                <span className={styles.chip}>Poster</span>
                <span className={styles.chip}>Carousel</span>
                <span className={styles.chip}>Reel</span>
              </div>
              <div className={styles.planLine} aria-hidden="true">
                <span className={styles.planNode} />
                <span className={styles.planBar} />
                <span className={styles.planNode} />
                <span className={styles.planBarShort} />
                <span className={styles.planNode} />
              </div>
            </div>
          </Feature>

          <Feature icon={<CalendarIcon />} title="A calendar that keeps up.">
            <p>
              Drag a post to another day, or use the date field on the card. Every move keeps its
              time and can be moved back.
            </p>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.week}>
                <span className={styles.day}>Mon</span>
                <span className={styles.day}>Tue</span>
                <span className={`${styles.day} ${styles.dayActive}`}>Wed</span>
                <span className={styles.day}>Thu</span>
                <span className={styles.day}>Fri</span>
              </div>
            </div>
          </Feature>

          <Feature icon={<ReceiptIcon />} title="Credits you can audit.">
            <p>
              Reserve first, capture on success, refund on failure. The ledger is append-only, and
              reconciliation can prove the balance.
            </p>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.miniLedger}>
                <span>Reserve</span>
                <span className={styles.ledgerArrow}>→</span>
                <span className={styles.ledgerGood}>Capture</span>
              </div>
              <div className={styles.miniLedger}>
                <span>Failure</span>
                <span className={styles.ledgerArrow}>→</span>
                <span className={styles.ledgerWarm}>Refund</span>
              </div>
            </div>
          </Feature>

          <Feature icon={<ShieldIcon />} title="Publishing that survives retries.">
            <p>
              A transactional outbox, leases and heartbeats mean a crashed worker cannot lose a job.
              Idempotency at three levels means it cannot post twice.
            </p>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.flow}>
                <span className={styles.flowStep}>Outbox</span>
                <ArrowRight className={styles.flowArrow} />
                <span className={styles.flowStep}>Worker</span>
                <ArrowRight className={styles.flowArrow} />
                <span className={`${styles.flowStep} ${styles.flowStepGood}`}>Published</span>
              </div>
            </div>
          </Feature>

          <Feature icon={<ChartIcon />} title="Numbers with a next move.">
            <p>
              Platform snapshots feed a campaign view, then a suggestion for what to make next —
              based on what already worked, not on a horoscope.
            </p>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.bars}>
                <span className={styles.bar} style={{ height: '38%' }} />
                <span className={styles.bar} style={{ height: '58%' }} />
                <span className={`${styles.bar} ${styles.barHot}`} style={{ height: '88%' }} />
                <span className={styles.bar} style={{ height: '52%' }} />
                <span className={styles.bar} style={{ height: '68%' }} />
              </div>
              <p className={styles.suggestion}>
                <SparkIcon /> Try a carousel next
              </p>
            </div>
          </Feature>
        </div>
      </section>

      <section id="how-it-works" className={styles.section} aria-labelledby="how-it-works-title">
        <div className={styles.sectionHead}>
          <p className={styles.eyebrow}>Three steps, one afternoon</p>
          <h2 id="how-it-works-title" className={styles.sectionTitle}>
            You bring the brand. The studio does the rest.
          </h2>
        </div>

        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              01
            </span>
            <h3>Tell us about your brand.</h3>
            <p>
              Industry, colours, languages and tone. One brief becomes the context for every asset,
              so the campaign sounds like you.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              02
            </span>
            <h3>Generate, then approve.</h3>
            <p>
              The studio drafts the plan, captions and visuals. Keep what fits, edit the rest, or
              regenerate a single scene without redoing the whole reel.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              03
            </span>
            <h3>Schedule once.</h3>
            <p>
              Pick accounts and slots. RenderFlow publishes on time, records the platform id, and
              retries safely if a provider stumbles.
            </p>
          </li>
        </ol>
      </section>

      <section className={styles.quoteBand} aria-label="The reliability brief">
        <div className={styles.quoteInner}>
          <span className={styles.quoteMark} aria-hidden="true">
            “
          </span>
          <p className={styles.quoteText}>
            A crash at any point must never lose a job, double charge, or double post.
          </p>
          <p className={styles.quoteAttribution}>The RenderFlow design brief</p>
        </div>
      </section>

      <section id="faq" className={`${styles.section} ${styles.faq}`} aria-labelledby="faq-title">
        <div>
          <p className={styles.eyebrow}>Questions, answered</p>
          <h2 id="faq-title" className={styles.sectionTitle}>
            Before you write the first brief.
          </h2>
          <p className={styles.sectionLede}>
            No hidden subscription, no charge for a failed render, and nothing published without
            your approval.
          </p>
        </div>

        <div className={styles.faqList}>
          {FAQ.map((item) => (
            <details key={item.question} className={styles.faqItem}>
              <summary>
                {item.question}
                <span className={styles.faqIcon} aria-hidden="true">
                  +
                </span>
              </summary>
              <p className={styles.faqAnswer}>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={styles.finalCta} aria-labelledby="final-cta-title">
        <div className={styles.finalPanel}>
          <div>
            <h2 id="final-cta-title" className={styles.finalTitle}>
              Your next campaign is one brief away.
            </h2>
            <p className={styles.finalCopy}>
              Start with free credits. Approve every asset. Let the calendar do the remembering.
            </p>
          </div>
          <Link className={styles.primaryCta} href="/register">
            Start free
            <ArrowRight className={styles.ctaArrow} />
          </Link>
        </div>
      </section>
    </MarketingPage>
  );
}

function Feature({
  icon,
  title,
  wide = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article className={`${styles.feature} ${wide ? styles.featureWide : ''}`}>
      <span className={styles.featureIcon}>{icon}</span>
      <h3>{title}</h3>
      <div className={styles.featureBody}>{children}</div>
    </article>
  );
}

function TrustItem({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className={styles.trustItem}>
      <span className={styles.trustIcon}>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

/**
 * A stylised studio board, built from HTML and CSS rather than a screenshot.
 *
 * `role="img"` gives a screen reader one useful description instead of a stream
 * of labels from a picture that is only there to show the shape of the product.
 * The inner layers are decorative and hidden.
 */
function Preview() {
  return (
    <figure className={styles.previewWrap}>
      <div
        className={styles.previewFrame}
        role="img"
        aria-label="Preview of the RenderFlow studio: an autumn campaign with a generated caption, poster and reel, three scheduled slots, and a credit ledger that reserves, captures and refunds."
      >
        <div className={styles.previewBar} aria-hidden="true">
          <span className={styles.dots}>
            <span />
            <span />
            <span />
          </span>
          <span className={styles.previewTitle}>Studio / Autumn launch</span>
          <span className={styles.previewBadge}>Preview</span>
        </div>

        <div className={styles.previewBody} aria-hidden="true">
          <div className={styles.previewMain}>
            <div className={styles.previewCampaign}>
              <div>
                <span className={styles.previewLabel}>Campaign</span>
                <strong>Autumn launch</strong>
              </div>
              <span className={styles.statusChip}>Draft</span>
            </div>

            <div className={styles.captionCard}>
              <span className={styles.previewLabel}>Caption · generated</span>
              <p>
                “Golden hour, every hour. The autumn edit is here — warm layers, quiet colour, made
                to move.”
              </p>
              <div className={styles.hashtags}>
                <span>#AutumnEdit</span>
                <span>#NewSeason</span>
              </div>
            </div>

            <div className={styles.assetRow}>
              <div className={styles.assetPoster}>
                <span>Poster</span>
                <span className={styles.assetMeta}>2 variants</span>
              </div>
              <div className={styles.assetReel}>
                <span className={styles.playIcon} />
                <span>Reel</span>
                <span className={styles.assetMeta}>18s · 9:16</span>
              </div>
            </div>
          </div>

          <aside className={styles.previewSide}>
            <div className={styles.sideCard}>
              <span className={styles.previewLabel}>This week</span>
              <div className={styles.slot}>
                <span className={styles.slotDay}>Tue</span>
                <strong>09:00</strong>
                <span className={styles.dotBlue} />
              </div>
              <div className={styles.slot}>
                <span className={styles.slotDay}>Wed</span>
                <strong>12:30</strong>
                <span className={styles.dotBlue} />
              </div>
              <div className={styles.slot}>
                <span className={styles.slotDay}>Thu</span>
                <strong>18:00</strong>
                <span className={styles.dotOrange} />
              </div>
            </div>

            <div className={styles.sideCard}>
              <span className={styles.previewLabel}>Credits</span>
              <div className={styles.ledgerRow}>
                <span>Reserved</span>
                <span className={styles.ledgerState}>before work</span>
              </div>
              <div className={styles.ledgerRow}>
                <span>Captured</span>
                <span className={styles.ledgerGood}>on success</span>
              </div>
              <div className={styles.ledgerRow}>
                <span>Refunded</span>
                <span className={styles.ledgerWarm}>on failure</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
      <figcaption className={styles.previewCaption}>
        Preview · sample data. Your studio starts with free credits.
      </figcaption>
    </figure>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9L5.3 10.2l4.9-1.8L12 3.5z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
      <path d="M8 13h2.5M13.5 13H16M8 16.5h2.5M13.5 16.5H16" />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5.5c0 4.4-2.9 8-7 9.5-4.1-1.5-7-5.1-7-9.5V6l7-3z" />
      <path d="M8.5 12l2.4 2.4 4.6-4.8" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9a6 6 0 0 1 10.2-3.2L17 8.5M20 15a6 6 0 0 1-10.2 3.2L7 15.5" />
      <path d="M17 4.5v4h-4M7 19.5v-4h4" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="12" r="4.5" />
      <path d="M12.5 12H21M17.5 12v3M20 12v2.5" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6M20 16V6" />
    </svg>
  );
}
