import type { ReactNode } from 'react';

import styles from './ui.module.css';

/**
 * The primitives every screen is built from.
 *
 * Small, unopinionated, and each one carrying the accessibility behaviour that
 * is easy to forget at a call site: the field wires its label, hint and error to
 * the input by id; the dialog traps focus and closes on Escape; the button
 * announces its own busy state.
 *
 * Keeping them here rather than in each screen means "is this labelled?" has one
 * answer instead of thirty-nine.
 */

export function Card({
  title,
  description,
  children,
  actions,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${styles.card} ${className ?? ''}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className={styles.cardHeader}>
          <div>
            {title !== undefined && <h2 className={styles.cardTitle}>{title}</h2>}
            {description !== undefined && <p className={styles.cardDescription}>{description}</p>}
          </div>
          {actions !== undefined && <div className={styles.cardActions}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * The first thing on every screen: what page this is and what it is for.
 *
 * A shared header keeps the title level, spacing and action placement from
 * drifting per page, which is the difference between a product and a pile of
 * screens that each made their own decision.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderCopy}>
        {eyebrow !== undefined && <p className={styles.pageEyebrow}>{eyebrow}</p>}
        <h1 className={styles.pageTitle}>{title}</h1>
        {description !== undefined && <p className={styles.pageDescription}>{description}</p>}
        {meta !== undefined && <div className={styles.pageMeta}>{meta}</div>}
      </div>
      {actions !== undefined && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

export type StatTone = 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * A single number with enough context to act on.
 *
 * The label is a heading so a screen reader can jump between the numbers rather
 * than hearing one undifferentiated paragraph. The hint is where the unit and
 * the comparison live; a bare "50" on a dashboard is trivia.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'accent',
  badge,
  progress,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  badge?: ReactNode;
  progress?: number;
}) {
  return (
    <section className={styles.statCard}>
      <div className={styles.statTop}>
        <h2 className={styles.kpiLabel}>{label}</h2>
        {icon !== undefined && (
          <span className={`${styles.statIcon} ${styles[`statIcon_${tone}`] ?? ''}`}>{icon}</span>
        )}
      </div>
      <p className={styles.kpiValue}>{value}</p>
      {(hint !== undefined || badge !== undefined) && (
        <div className={styles.statFoot}>
          {hint !== undefined && <span className={styles.statHint}>{hint}</span>}
          {badge}
        </div>
      )}
      {progress !== undefined && (
        <div className={styles.statProgress} aria-hidden="true">
          <span
            className={styles.statProgressFill}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </div>
      )}
    </section>
  );
}

export function Button({
  children,
  variant = 'secondary',
  busy = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  busy?: boolean;
}) {
  return (
    <button
      {...rest}
      // `disabled` while busy, so a double click cannot start a second
      // generation - which would charge credits twice.
      disabled={rest.disabled === true || busy}
      aria-busy={busy}
      className={`${styles.button} ${styles[variant] ?? ''}`}
    >
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * A labelled input.
 *
 * The render prop receives the id, the `describedby` value and the invalid flag
 * together, because wiring a label and its description but forgetting
 * `aria-invalid` is the exact half-finished state this component exists to
 * prevent - and a caller who has to remember which of three attributes to copy
 * will eventually forget one.
 */
export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  id: string;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy =
    [errorId, hintId].filter((value) => value !== undefined).join(' ') || undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {hint !== undefined && (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        // `role="alert"` so a screen reader announces it when it appears, which
        // is the only moment the user can act on it.
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Announces a message to assistive tech without showing it. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}

export function Badge({
  tone = 'neutral',
  pulse = false,
  children,
}: {
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'teal';
  /** Pulse is reserved for in-flight states: GENERATING and PUBLISHING. */
  pulse?: boolean;
  children: ReactNode;
}) {
  const className = [styles.badge, styles[`badge_${tone}`] ?? '', pulse ? styles.badge_pulse : '']
    .filter(Boolean)
    .join(' ');

  return <span className={className}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      {icon !== undefined && <span className={styles.emptyIcon}>{icon}</span>}
      <h3>{title}</h3>
      <p className={styles.cardDescription}>{description}</p>
      {action}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.errorNotice} role="alert">
      <p>{message}</p>
      {onRetry !== undefined && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </p>
  );
}
