import Link from 'next/link';
import type { ReactNode } from 'react';

import { Icon } from './icons';
import { ThemeToggle } from './theme-toggle';
import styles from './auth-shell.module.css';

/**
 * The frame around every account screen.
 *
 * Authentication is the first thing a new user sees, and it used to be a lone
 * card floating in an empty page. This gives those screens the same identity as
 * the product behind them: the brand panel explains what RenderFlow does while
 * the form stays the only thing asking for attention.
 *
 * The panel is marketing copy, not a second form. On a phone it is removed
 * entirely rather than stacked above the fields, because someone signing in on
 * a small screen wants the form, not a pitch.
 *
 * `id="main"` matters: the root layout's skip link targets it, and the bare
 * routes render without the application shell that normally owns that id.
 */
export function AuthShell({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <aside className={styles.aside}>
        <Link href="/" className={styles.brand} aria-label="RenderFlow home">
          <span className={styles.brandMark}>
            <Icon name="sparkles" size={17} />
          </span>
          <span className={styles.brandWord}>RenderFlow</span>
        </Link>

        <div className={styles.asideCopy}>
          <p className={styles.asideEyebrow}>AI marketing studio</p>
          <h2 className={styles.asideTitle}>The whole campaign, in one flow.</h2>
          <p className={styles.asideLede}>
            RenderFlow writes the copy, generates the visuals and publishes approved posts on
            schedule. You keep the brand and the final say.
          </p>

          <ul className={styles.asideList}>
            <li className={styles.asideItem}>
              <span className={styles.asideItemIcon}>
                <Icon name="sparkles" size={15} />
              </span>
              <span>
                <strong>Brief to draft in minutes</strong>
                Captions, posters and reels generated in your brand voice.
              </span>
            </li>
            <li className={styles.asideItem}>
              <span className={styles.asideItemIcon}>
                <Icon name="shield" size={15} />
              </span>
              <span>
                <strong>Approval before publish</strong>
                Every public post passes an approver. Nothing slips out by accident.
              </span>
            </li>
            <li className={styles.asideItem}>
              <span className={styles.asideItemIcon}>
                <Icon name="credits" size={15} />
              </span>
              <span>
                <strong>Credits you can audit</strong>
                Reserved before work, refunded automatically when a job fails.
              </span>
            </li>
          </ul>
        </div>

        <div className={styles.preview} aria-hidden="true">
          <div className={styles.previewTop}>
            <span className={styles.previewLabel}>
              <Icon name="calendar" size={13} />
              Today&apos;s queue
            </span>
            <span className={styles.previewCount}>3 scheduled</span>
          </div>
          <div className={styles.previewRow}>
            <span className={`${styles.previewDot} ${styles.previewDotReady}`} />
            <span className={styles.previewCopy}>
              <span className={styles.previewTitle}>Spring collection teaser</span>
              <span className={styles.previewMeta}>Instagram · 10:30</span>
            </span>
            <span className={styles.previewStatus}>Ready</span>
          </div>
          <div className={styles.previewRow}>
            <span className={`${styles.previewDot} ${styles.previewDotDraft}`} />
            <span className={styles.previewCopy}>
              <span className={styles.previewTitle}>Behind the fabric</span>
              <span className={styles.previewMeta}>LinkedIn · 14:00</span>
            </span>
            <span className={styles.previewStatus}>Draft</span>
          </div>
          <div className={styles.previewRow}>
            <span className={`${styles.previewDot} ${styles.previewDotReady}`} />
            <span className={styles.previewCopy}>
              <span className={styles.previewTitle}>Weekend styling notes</span>
              <span className={styles.previewMeta}>TikTok · 18:15</span>
            </span>
            <span className={styles.previewStatus}>Ready</span>
          </div>
        </div>

        <p className={styles.asideFootnote}>
          Built for teams that ship the campaign, not the calendar.
        </p>
      </aside>

      <main id="main" className={styles.main}>
        <div className={styles.topline}>
          <Link href="/" className={styles.mobileBrand} aria-label="RenderFlow home">
            <span className={styles.brandMark}>
              <Icon name="sparkles" size={16} />
            </span>
            <span className={styles.brandWord}>RenderFlow</span>
          </Link>
          <div className={styles.themeSlot}>
            <ThemeToggle />
          </div>
        </div>

        <div className={styles.formWrap}>
          <div className={styles.formHead}>
            <p className={styles.eyebrow}>{eyebrow}</p>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.description}>{description}</p>
          </div>

          {children}

          {footer !== undefined && <div className={styles.footerSlot}>{footer}</div>}
        </div>

        <footer className={styles.mainFooter}>
          <span>© 2026 RenderFlow</span>
          <nav aria-label="Legal">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/security">Security</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
