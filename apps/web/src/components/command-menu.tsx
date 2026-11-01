'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from './icons';
import { NAV_ITEMS, type NavItem } from './navigation';
import styles from './shell.module.css';

const COMMANDS: readonly NavItem[] = [
  ...NAV_ITEMS,
  {
    href: '/brands/new',
    label: 'New brand',
    icon: 'plus',
    section: 'Workspace',
    description: 'Create a brand and start a campaign',
    keywords: 'create add',
  },
];

/**
 * Quick navigation, opened from the top bar or with Cmd/Ctrl+K.
 *
 * A command menu rather than a permanent search field because there is not yet
 * a cross-entity search endpoint. It only offers destinations that exist, which
 * keeps the affordance honest: pressing a result always goes somewhere real.
 */
export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
      return COMMANDS;
    }

    return COMMANDS.filter((item) =>
      [item.label, item.description, item.keywords ?? ''].join(' ').toLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery('');
    setActive(0);
    input.current?.focus();

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) {
    return null;
  }

  const go = (href: string): void => {
    onClose();
    router.push(href);
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-title"
      >
        <div className={styles.dialogHeader}>
          <Icon name="search" className={styles.dialogSearchIcon} />
          <label id="command-title" className="sr-only" htmlFor="command-input">
            Search RenderFlow
          </label>
          <input
            ref={input}
            id="command-input"
            className={styles.dialogInput}
            placeholder="Search pages and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, results.length - 1));
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              }

              if (event.key === 'Enter') {
                const chosen = results[active];

                if (chosen !== undefined) {
                  event.preventDefault();
                  go(chosen.href);
                }
              }
            }}
          />
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label="Close search"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className={styles.dialogBody}>
          {results.length === 0 ? (
            <p className={styles.dialogEmpty}>No page matches “{query}”.</p>
          ) : (
            results.map((item, index) => (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.dialogItem} ${index === active ? styles.dialogItemActive : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={onClose}
              >
                <span className={styles.dialogItemIcon}>
                  <Icon name={item.icon} size={16} />
                </span>
                <span className={styles.dialogItemCopy}>
                  <span className={styles.dialogItemTitle}>{item.label}</span>
                  <span className={styles.dialogItemDescription}>{item.description}</span>
                </span>
              </Link>
            ))
          )}
        </div>

        <div className={styles.dialogFooter}>
          <span>
            <kbd className={styles.kbd}>↑</kbd>
            <kbd className={styles.kbd}>↓</kbd> to move
          </span>
          <span>
            <kbd className={styles.kbd}>↵</kbd> to open
          </span>
          <span>
            <kbd className={styles.kbd}>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
