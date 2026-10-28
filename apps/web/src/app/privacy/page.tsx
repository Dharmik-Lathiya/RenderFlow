import type { Metadata } from 'next';

import { MarketingPage } from '../../components/marketing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

export const metadata: Metadata = {
  title: 'Privacy Policy — RenderFlow',
  description:
    'What RenderFlow stores, why, who processes it, how long it is kept, and how to ask for it to be removed.',
};

/**
 * Privacy policy.
 *
 * Written against the schema: `users`, `wallets`, `credit_ledger`, `brands`,
 * `posts`, `assets`, `social_accounts`, `post_metrics`, `notifications`,
 * `audit_logs`. If a field is not in one of those tables, this page does not
 * claim to collect it.
 */
export default function PrivacyPage() {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@renderflow.example';

  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={styles.page}>
        <p className={styles.eyebrow}>Legal</p>
        <h1 className={styles.title}>Privacy Policy</h1>

        <p className={styles.note}>
          This policy describes what this deployment stores today. The operating entity and the
          contact details for data-protection requests must be completed before a commercial launch.
        </p>

        <div className={styles.prose}>
          <h2>What we store</h2>
          <ul>
            <li>
              <strong>Account:</strong> your email address, display name, a password hash, and the
              workspaces and roles you belong to.
            </li>
            <li>
              <strong>Brand material:</strong> the brand brief you enter — name, industry, tone,
              audience, colours, languages — and any logo or asset you upload.
            </li>
            <li>
              <strong>Campaigns and posts:</strong> goals, captions, hashtags, schedules, approvals,
              and the assets generated or uploaded for them.
            </li>
            <li>
              <strong>Connected accounts:</strong> the platform, the external account id, and access
              and refresh tokens. Tokens are encrypted with AES-256-GCM; the plaintext is never
              returned by the API or written to logs.
            </li>
            <li>
              <strong>Metrics:</strong> likes, comments, reach and clicks for published posts,
              pulled from the platform.
            </li>
            <li>
              <strong>Credits:</strong> your balance and an append-only ledger of every movement,
              including the reference for the job or order that caused it.
            </li>
            <li>
              <strong>Operational records:</strong> job state for reliability, notifications you
              receive, and an audit log of operator actions such as credit adjustments.
            </li>
          </ul>

          <h2>Cookies</h2>
          <p>
            Two cookies, both required for the service to work: an httpOnly session cookie and a
            CSRF token cookie that the browser echoes in a header. There is no advertising or
            third-party analytics cookie in this application.
          </p>

          <h2>Why we process it</h2>
          <ul>
            <li>To run generation and scheduling, which is the service you asked for.</li>
            <li>To keep the credit ledger accurate and auditable.</li>
            <li>To secure accounts and investigate abuse.</li>
            <li>To tell you when a publish failed or a job was refunded.</li>
          </ul>

          <h2>Who processes it</h2>
          <p>
            Depending on configuration, generation calls go to a language-model provider, an image
            provider and a text-to-speech provider; assets are stored in object storage; and
            publishing goes to the social platforms you connect. Those providers receive only the
            input needed for the step — the brand brief and the specific generation request, or the
            asset being published. This deployment runs on mocks until a provider key is configured.
          </p>

          <h2>How long it is kept</h2>
          <ul>
            <li>
              Ledger rows are append-only and kept for as long as the account exists, because a
              balance that cannot be reconstructed is not auditable.
            </li>
            <li>Generated assets are kept until you delete them or close the account.</li>
            <li>Job records are retained for operational forensics and then aged out.</li>
            <li>Revoking a connected account deletes its stored tokens.</li>
          </ul>

          <h2>Your rights</h2>
          <p>
            You can read your own ledger in the app, delete assets and posts, disconnect accounts,
            and ask for a copy or deletion of your account data. Write to{' '}
            <a href={`mailto:${supportEmail}`}>{supportEmail}</a>. Deletion removes your content and
            credentials; ledger history is retained where required for financial integrity, without
            the content it referenced.
          </p>

          <h2>Security</h2>
          <p>
            Controls are listed on the <a href="/security">security page</a>. If a breach affects
            your data, we will notify affected account holders without undue delay.
          </p>

          <h2>Changes</h2>
          <p>
            Material changes will be announced in the app before they take effect, and the effective
            date below will change.
          </p>
        </div>

        <p className={styles.meta}>Effective 28 October 2026.</p>
      </div>
    </MarketingPage>
  );
}
