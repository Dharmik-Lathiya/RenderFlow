import styles from './page.module.css';

/**
 * Phase 0 landing page.
 *
 * Deliberately a server component with no client hooks: it exists to prove the
 * Next.js app builds and renders. The real dashboard screens land in Phase 8
 * (PROJECT.md section 12).
 */
export default function Home(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <h1>RenderFlow</h1>
      <p>
        AI marketing studio and social scheduler. Every new workspace starts with{' '}
        <strong>50 free credits</strong>.
      </p>
      <div className={styles.stack}>
        <p className={styles.muted}>
          Frontend in <code>apps/web</code>, HTTP API in <code>apps/api</code>. Both talk through
          the shared <code>@renderflow/api-client</code>, so a future mobile app uses the same
          contract.
        </p>
        <p>
          <span className={styles.badge}>Phase 0 foundation</span>
        </p>
      </div>
    </div>
  );
}
