'use client';

import { Icon } from './icons';
import { useTheme } from '../lib/theme';
import styles from './ui.module.css';

/**
 * Appearance control for the application shell.
 *
 * The switch shows the current mode, while the accessible name describes the
 * action. A control that only shows an icon makes a sighted user guess; one that
 * only says "switch to dark" leaves the current state ambiguous. This says both.
 */
export function ThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className={styles.themeToggle}
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span className={styles.themeToggleIcon}>
        <Icon name={resolvedTheme === 'dark' ? 'moon' : 'sun'} size={15} />
      </span>
      <span className={styles.themeToggleLabel}>Appearance</span>
      <span className={styles.themeToggleValue}>{resolvedTheme === 'dark' ? 'Dark' : 'Light'}</span>
      <span className={styles.toggleTrack} data-on={resolvedTheme === 'dark'} aria-hidden="true">
        <span className={styles.toggleThumb} />
      </span>
    </button>
  );
}
