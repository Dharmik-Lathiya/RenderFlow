import type { Metadata } from 'next';

import { MarketingPage } from '../../components/marketing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

export const metadata: Metadata = {
  title: 'Security — RenderFlow',
  description:
    'How RenderFlow protects accounts, social tokens, uploaded assets and the credit ledger.',
};

/**
 * Security.
 *
 * Every claim here is a control that exists in this repository, not an aspiration:
 * see `libs/credits`, `apps/api/src/auth`, `WorkspaceAccessService` and
 * `infra/prometheus/alerts.yml`. A security page that describes a control nobody
 * built is worse than no page at all.
 */
export default function SecurityPage() {
  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={styles.page}>
        <p className={styles.eyebrow}>Security</p>
        <h1 className={styles.title}>What protects your account and your credits.</h1>
        <p className={styles.lede}>
          A short, specific page. If a control is not listed here, assume it is not in place and ask
          us before relying on it.
        </p>

        <div className={styles.prose}>
          <h2>Accounts</h2>
          <ul>
            <li>Passwords are hashed with argon2. The plaintext is never stored or logged.</li>
            <li>
              Sessions use httpOnly, SameSite cookies. The access token is short-lived and the
              refresh token is rotated on use.
            </li>
            <li>
              Cookie-authenticated writes require a double-submit CSRF token, so another site cannot
              act as you.
            </li>
            <li>
              Login and registration are rate limited per address, and login additionally per
              submitted email — the per-account limit is what stops credential stuffing aimed at one
              address from many hosts.
            </li>
          </ul>

          <h2>Your workspace</h2>
          <ul>
            <li>
              Every workspace-scoped query is checked for membership before it runs, and “not yours”
              returns the same answer as “does not exist”, so ids cannot be probed.
            </li>
            <li>
              Writing and approving are separate permissions below owner: the person who wrote a
              caption cannot be the one who signs it off.
            </li>
          </ul>

          <h2>Social accounts</h2>
          <ul>
            <li>
              Access and refresh tokens are encrypted at rest with AES-256-GCM, from a key held
              outside the database.
            </li>
            <li>Tokens are never returned by the API and never written to logs.</li>
          </ul>

          <h2>Credits</h2>
          <ul>
            <li>
              Only one module can write a balance, and every movement is an append-only ledger row.
            </li>
            <li>
              Reserving is a single guarded transaction: 100 simultaneous requests against a balance
              of 50 cannot overspend it.
            </li>
            <li>
              Every ledger row carries a unique reference, so a retried refund or capture is a no-op
              rather than a second movement.
            </li>
            <li>
              A reconciliation job compares each wallet to its ledger per bucket and alerts on any
              drift.
            </li>
          </ul>

          <h2>Uploads and generation</h2>
          <ul>
            <li>
              Uploads are restricted to an allow list of image, audio, video and PDF types with a
              size ceiling; a declared size is checked before a presigned URL is issued and the real
              size is read back on confirm.
            </li>
            <li>
              Prompts are moderated before credits are reserved, and brand text is treated as
              untrusted data rather than as instructions to the model.
            </li>
          </ul>

          <h2>Operations</h2>
          <ul>
            <li>
              Security headers on every API response; CORS is an explicit allow list, never `*`.
            </li>
            <li>Operator actions, including credit adjustments, are written to an audit log.</li>
            <li>Alerts fire on ledger drift, stuck jobs, abandoned events and refund spikes.</li>
          </ul>

          <h2>Reporting a problem</h2>
          <p>
            Write to the address on the <a href="/contact">contact page</a> with “security” in the
            subject. Please do not test against another customer&apos;s workspace or data.
          </p>
        </div>

        <p className={styles.meta}>Last reviewed: 28 October 2026.</p>
      </div>
    </MarketingPage>
  );
}
