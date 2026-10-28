import type { Metadata } from 'next';

import { MarketingPage } from '../../components/marketing';
import { fontClassName } from '../fonts';
import styles from '../marketing.module.css';

export const metadata: Metadata = {
  title: 'Terms of Service — RenderFlow',
  description: 'The terms that apply to a RenderFlow account, credits and generated content.',
};

/**
 * Terms of service.
 *
 * Plain language on purpose, and deliberately silent on the things this repository
 * cannot know: the operating entity, the governing jurisdiction and the liability
 * cap. Those are business decisions, not copy, so the clauses that depend on them
 * are marked for review rather than invented here.
 */
export default function TermsPage() {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@renderflow.example';

  return (
    <MarketingPage fontClassName={fontClassName}>
      <div className={styles.page}>
        <p className={styles.eyebrow}>Legal</p>
        <h1 className={styles.title}>Terms of Service</h1>

        <p className={styles.note}>
          These terms describe how this deployment works. The operating entity, governing law and
          liability position are business decisions that must be completed and reviewed by counsel
          before a commercial launch.
        </p>

        <div className={styles.prose}>
          <h2>1. The service</h2>
          <p>
            RenderFlow generates marketing content from a brand brief you provide and publishes
            approved posts to social accounts you connect. You need an account, a valid email
            address and the right to act for the brand you configure.
          </p>

          <h2>2. Your account</h2>
          <ul>
            <li>
              You are responsible for activity under your account and for keeping credentials safe.
            </li>
            <li>You must be old enough to enter a contract in your jurisdiction.</li>
            <li>
              Workspace owners choose who may view, write and approve. Publishing is available to
              approvers and owners.
            </li>
          </ul>

          <h2>3. Credits</h2>
          <ul>
            <li>
              Credits are a prepaid unit for generation. They are not money, earn no interest and
              cannot be transferred between accounts.
            </li>
            <li>
              Credits are reserved when generation starts and captured when it completes. If the
              system fails after its retries, the reservation is returned to your balance.
            </li>
            <li>
              If a request is refused because it violates these terms or our moderation policy, it
              is refused before any credits are reserved.
            </li>
            <li>
              Prices are set by the service and shown in the app and on the pricing page; the price
              in force when a job starts is the price charged.
            </li>
          </ul>

          <h2>4. Your content</h2>
          <p>
            You keep ownership of the brand material you upload and of the content generated for
            your brand. You grant us the licence needed to process it — to call model providers,
            store assets and publish to the accounts you connect — and for nothing else.
          </p>
          <p>
            You are responsible for having the rights to any material you upload, and for reviewing
            generated content before it is published. Generation is probabilistic: output can be
            wrong, and approval is where a human takes responsibility for it.
          </p>

          <h2>5. Acceptable use</h2>
          <p>You may not use the service to:</p>
          <ul>
            <li>create or publish content that is unlawful, deceptive or infringing;</li>
            <li>impersonate a person or organisation, or misrepresent an endorsement;</li>
            <li>
              target minors, harass anyone, or publish another person&apos;s private information;
            </li>
            <li>
              probe, overload or bypass the service&apos;s rate limits, or access another
              workspace&apos;s data.
            </li>
          </ul>
          <p>
            Moderation runs before credits are reserved, and an account that repeatedly trips it may
            be suspended.
          </p>

          <h2>6. Connected platforms</h2>
          <p>
            Publishing depends on third-party platforms and the permissions you grant them. Their
            terms apply in addition to these, and a platform may rate limit, reject or remove a post
            for reasons outside our control.
          </p>

          <h2>7. Availability and changes</h2>
          <p>
            The service may change, and features may be added or removed. We may suspend an account
            that threatens the service or other customers. Material changes to these terms will be
            announced in the app before they take effect.
          </p>

          <h2>8. Termination</h2>
          <p>
            You can stop using the service at any time and ask for your account to be closed. Unused
            credits are not refundable unless required by law. We may close an account that breaches
            these terms.
          </p>

          <h2>9. Disclaimers and liability</h2>
          <p>
            The service is provided “as is”. Generated content is not legal, medical or financial
            advice, and publishing it is your decision. Nothing here excludes liability that cannot
            be excluded by law.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about these terms: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
          </p>
        </div>

        <p className={styles.meta}>Effective 28 October 2026.</p>
      </div>
    </MarketingPage>
  );
}
