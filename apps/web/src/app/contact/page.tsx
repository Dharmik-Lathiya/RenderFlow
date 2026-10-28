import type { Metadata } from 'next';

import { MarketingPage } from '../../components/marketing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

export const metadata: Metadata = {
  title: 'Contact — RenderFlow',
  description:
    'How to reach RenderFlow support about your account, credits or a failed generation.',
};

/**
 * Contact.
 *
 * No form: a form needs an endpoint, a spam story and a delivery guarantee, and a
 * form that silently drops a message is worse than an address. The address comes
 * from configuration so a deployment cannot ship a dead mailto.
 */
export default function ContactPage() {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@renderflow.example';

  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={styles.page}>
        <p className={styles.eyebrow}>Contact</p>
        <h1 className={styles.title}>Talk to a person.</h1>
        <p className={styles.lede}>
          One address, read by the people who build this. Include the account email and the post or
          job id if you have one — it is the difference between a reply and three questions.
        </p>

        <div className={styles.prose}>
          <h2>Support</h2>
          <p>
            <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
          </p>

          <h2>What to include</h2>
          <ul>
            <li>
              <strong>A credit question:</strong> the account email. Every ledger row is
              append-only, so a balance can be reconstructed exactly.
            </li>
            <li>
              <strong>A failed generation:</strong> the post id. The job records its stage, its
              attempts and whether the reservation was refunded.
            </li>
            <li>
              <strong>A failed publish:</strong> the account you connected and the time it was due.
              Nothing is retried blindly — the platform is checked before a second attempt.
            </li>
          </ul>

          <h2>Security reports</h2>
          <p>
            If you believe you have found a vulnerability, say so in the subject line and do not
            include proof-of-concept data belonging to another account. See{' '}
            <a href="/security">security</a> for what is in scope.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
