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
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={styles.card}>
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
  children,
}: {
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
  children: ReactNode;
}) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`] ?? ''}`}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
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
