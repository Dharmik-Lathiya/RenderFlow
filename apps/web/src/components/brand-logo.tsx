import styles from './brand-logo.module.css';

/**
 * The RenderFlow wordmark and swoosh.
 *
 * Drawn in code rather than shipped as a raster asset so it stays crisp at any
 * size and follows the active palette (`DESIGN.md` section 2). The `Render` half
 * uses the ink colour, `Flow.` uses the accent, and the underline runs from the
 * ember accent through the secondary blue.
 *
 * The wordmark is real text, so the link around it still has an accessible name.
 * The full stop and the swoosh are decorative and hidden from assistive tech.
 */
export function BrandLogo({
  className,
  size = 'default',
}: {
  className?: string;
  size?: 'default' | 'large';
}) {
  return (
    <span
      className={[styles.logo, size === 'large' ? styles.large : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.wordmark}>
        <span className={styles.render}>Render</span>
        <span className={styles.flow}>Flow</span>
        <span className={styles.dot} aria-hidden="true">
          .
        </span>
      </span>

      <svg
        className={styles.swoosh}
        viewBox="0 0 200 16"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="renderflow-logo-swoosh" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--logo-swoosh-start)" />
            <stop offset="52%" stopColor="var(--logo-swoosh-mid)" />
            <stop offset="100%" stopColor="var(--logo-swoosh-end)" />
          </linearGradient>
        </defs>
        <path
          d="M2 12.5C34 2 67 12.5 103 10c36-2.5 66-5.5 95-8.5-29 6-59 9-95 12.5-36 3.5-69-5.5-101-1.5Z"
          fill="url(#renderflow-logo-swoosh)"
        />
      </svg>
    </span>
  );
}
