import type { Metadata } from 'next';
import Link from 'next/link';

import { MarketingPage } from '../../components/marketing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

export const metadata: Metadata = {
  title: 'About — RenderFlow',
  description:
    'RenderFlow is an AI marketing studio and social scheduler: a brand brief in, a reviewed campaign out, published on your calendar.',
};

/**
 * About.
 *
 * No founding story, headcount or funding claim: none of those are facts this
 * repository knows, and inventing them would be the least trustworthy thing a
 * marketing page can do. What is written here is what the product actually does.
 */
export default function AboutPage() {
  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={styles.page}>
        <p className={styles.eyebrow}>About</p>
        <h1 className={styles.title}>A studio and a calendar, not another dashboard.</h1>
        <p className={styles.lede}>
          Small teams do not need more tools. They need the campaign written, designed, approved and
          scheduled before the week runs out. RenderFlow is built around that one sequence.
        </p>

        <div className={styles.prose}>
          <h2>What it does</h2>
          <p>
            You describe a brand — its industry, tone, audience, colours and languages — and a goal.
            RenderFlow drafts a campaign: a content plan, captions with hashtags, posters, carousels
            and short reels. You edit what you want, approve what goes out, and schedule it. A
            worker publishes at the scheduled time, and the analytics page fills in from the
            platform.
          </p>

          <h2>Three rules the product is built on</h2>
          <h3>Approve before it publishes</h3>
          <p>
            Whoever writes the caption is not necessarily the person who signs it off. Editing an
            approved post withdraws the approval, because the alternative is text nobody reviewed
            reaching a public profile.
          </p>
          <h3>A failure costs nothing</h3>
          <p>
            Credits are reserved when work starts, not when it is requested. If generation fails
            after its retries, the reservation is returned exactly once and the failed job says so.
          </p>
          <h3>A crash must not lose or duplicate work</h3>
          <p>
            Jobs are written to Postgres and published to a queue through a transactional outbox.
            Workers hold a lease and a heartbeat, a reaper recovers the ones that stop, and every
            stage checkpoints so a retry resumes instead of starting over.
          </p>

          <h2>What it is not</h2>
          <ul>
            <li>Not a scheduler for every network. Instagram and LinkedIn are the workflows.</li>
            <li>Not a design tool. Assets are generated and editable, not hand-drawn.</li>
            <li>
              Not a black box. Every credit movement is an append-only ledger row you can read.
            </li>
          </ul>
        </div>

        <div className={styles.actions} style={{ marginTop: 32 }}>
          <Link className={styles.primary} href="/register">
            Create an account
          </Link>
          <Link className={styles.secondary} href="/pricing">
            See pricing
          </Link>
        </div>
      </div>
    </MarketingPage>
  );
}
