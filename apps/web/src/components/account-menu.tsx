'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from './icons';
import { ThemeToggle } from './theme-toggle';
import styles from './shell.module.css';

interface AccountMenuProps {
  user: { name: string; email: string };
  wallet?: { available: number; reserved: number };
  initials: string;
  onSignOut: () => void;
}

/**
 * The account popover.
 *
 * The sidebar already exposes credits, appearance and sign out on a wide screen.
 * This is the same set of controls for the top bar, which is the only account
 * surface a phone gets: without it, signing out is a desktop-only action.
 *
 * Not a modal: nothing behind it is inert, and Escape or a click outside closes
 * it. Focus starts on the trigger because the first link is one Tab away, which
 * is the same path the sidebar takes.
 */
export function AccountMenu({ user, wallet, initials, onSignOut }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (wrapper.current !== null && !wrapper.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.accountWrap} ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className={styles.topbarAvatar}
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {initials}
      </button>

      {open && (
        <div id={menuId} className={styles.accountMenu} aria-label="Account">
          <div className={styles.accountHeader}>
            <span className={styles.userAvatar}>{initials}</span>
            <span className={styles.userInfo}>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </span>
          </div>

          {wallet !== undefined && (
            <div className={styles.accountCredits}>
              <span className={styles.accountCreditsLabel}>Credit balance</span>
              <span className={styles.accountCreditsValue}>{wallet.available}</span>
            </div>
          )}

          <div className={styles.accountLinks}>
            <Link
              href="/settings/accounts"
              className={styles.accountItem}
              onClick={() => setOpen(false)}
            >
              <Icon name="accounts" size={16} />
              Accounts and settings
            </Link>
            <Link
              href="/notifications"
              className={styles.accountItem}
              onClick={() => setOpen(false)}
            >
              <Icon name="notifications" size={16} />
              Notifications
            </Link>
          </div>

          <div className={styles.accountDivider} />

          <ThemeToggle />

          <div className={styles.accountDivider} />

          <button
            type="button"
            className={`${styles.accountItem} ${styles.accountSignOut}`}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="signOut" size={16} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
