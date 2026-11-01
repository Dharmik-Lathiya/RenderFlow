'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useApi } from '../../lib/providers';
import { Icon } from '../../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatCard,
} from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * The notification centre.
 *
 * Unread first, because a centre that mixes the two makes the one that needs
 * acting on harder to find - and this is the surface that surfaces a publish
 * which failed, which is the single most actionable thing the product reports.
 */
export function NotificationCenter() {
  const api = useApi();
  const client = useQueryClient();

  const [unreadOnly, setUnreadOnly] = useState(false);

  const notifications = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () => api.notifications.list(unreadOnly),
    // A publish can fail while the page is open, so this polls. Thirty seconds is
    // long enough not to matter and short enough that a failure shows up while
    // the user is still looking at the screen.
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const list = notifications.data ?? [];
  const unread = list.filter((notification) => notification.readAt === null);
  const failed = list.filter((notification) => notification.type.toUpperCase().includes('FAIL'));
  const groups = groupByDay(list);

  return (
    <>
      <PageHeader
        eyebrow="Activity"
        title="Notifications"
        description="Publish results, credit movements and account alerts. A failed publish lands here with what went wrong."
        actions={
          <Button
            variant="secondary"
            busy={markAll.isPending}
            disabled={unread.length === 0}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        }
      />

      <div className={styles.kpiGrid}>
        <StatCard
          label="Unread"
          value={notifications.data === undefined ? '—' : unread.length}
          hint="needs your attention"
          icon={<Icon name="notifications" />}
          tone={unread.length > 0 ? 'warning' : 'success'}
        />
        <StatCard
          label="Total"
          value={notifications.data === undefined ? '—' : list.length}
          hint={unreadOnly ? 'in the unread view' : 'in this workspace'}
          icon={<Icon name="inbox" />}
          tone="info"
        />
        <StatCard
          label="Delivery issues"
          value={notifications.data === undefined ? '—' : failed.length}
          hint="publish failures"
          icon={<Icon name="alert" />}
          tone={failed.length > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card
        title="Inbox"
        description={
          unreadOnly ? 'Showing unread notifications only.' : 'Newest first, grouped by day.'
        }
        actions={
          <div className={styles.segmented} role="group" aria-label="Notification filter">
            <button
              type="button"
              className={`${styles.segmentedButton} ${
                unreadOnly ? '' : styles.segmentedButtonActive
              }`}
              aria-pressed={!unreadOnly}
              onClick={() => setUnreadOnly(false)}
            >
              All
            </button>
            <button
              type="button"
              className={`${styles.segmentedButton} ${
                unreadOnly ? styles.segmentedButtonActive : ''
              }`}
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly(true)}
            >
              Unread {unread.length > 0 ? `(${unread.length})` : ''}
            </button>
          </div>
        }
      >
        {notifications.isLoading && <Spinner label="Loading notifications" />}

        {notifications.isError && (
          <ErrorNotice
            message="Could not load notifications."
            onRetry={() => void notifications.refetch()}
          />
        )}

        {notifications.data !== undefined && list.length === 0 && (
          <EmptyState
            icon={<Icon name="inbox" size={18} />}
            title={unreadOnly ? 'Nothing unread' : 'No notifications'}
            description="A publish that fails tells you here rather than failing quietly."
          />
        )}

        {groups.map((group) => (
          <section key={group.label} className={styles.dateGroup}>
            <h3 className={styles.dateGroupLabel}>{group.label}</h3>
            <ul className={styles.notificationList}>
              {group.items.map((notification) => {
                const kind = kindOf(notification.type);

                return (
                  <li
                    key={notification.id}
                    className={`${styles.notificationItem} ${
                      notification.readAt === null ? styles.notificationUnread : ''
                    }`}
                  >
                    <span
                      className={`${styles.notificationIcon} ${
                        kind === 'bad'
                          ? styles.notificationIconBad
                          : kind === 'good'
                            ? styles.notificationIconGood
                            : ''
                      }`}
                      aria-hidden="true"
                    >
                      <Icon
                        name={
                          kind === 'bad' ? 'alert' : kind === 'good' ? 'check' : 'notifications'
                        }
                        size={16}
                      />
                    </span>

                    <span className={styles.notificationCopy}>
                      <span className={styles.notificationTitle}>
                        {notification.title}
                        {notification.readAt === null && (
                          <span className={styles.unreadDot} aria-label="Unread" />
                        )}
                      </span>
                      <span className={styles.notificationBody}>{notification.body}</span>
                      <span className={styles.notificationTime}>
                        {relativeTime(notification.createdAt)}
                      </span>
                    </span>

                    {notification.readAt === null ? (
                      <Button
                        variant="ghost"
                        busy={markRead.isPending && markRead.variables === notification.id}
                        onClick={() => markRead.mutate(notification.id)}
                      >
                        Mark read
                      </Button>
                    ) : (
                      <Badge>read</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </Card>
    </>
  );
}

function kindOf(type: string): 'bad' | 'good' | 'neutral' {
  const upper = type.toUpperCase();

  if (upper.includes('FAIL') || upper.includes('ERROR') || upper.includes('REFUND')) {
    return 'bad';
  }

  if (upper.includes('PUBLISH') || upper.includes('SUCCESS') || upper.includes('COMPLETE')) {
    return 'good';
  }

  return 'neutral';
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();

  if (!Number.isFinite(then)) {
    return '';
  }

  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));

  if (minutes < 1) {
    return 'Just now';
  }

  if (minutes < 60) {
    return `${minutes} minutes ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function groupByDay<T extends { createdAt: string }>(items: T[]): { label: string; items: T[] }[] {
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups = new Map<string, { label: string; items: T[] }>();

  for (const item of items) {
    const created = new Date(item.createdAt);
    const key = dayKey(created);
    const label =
      key === today
        ? 'Today'
        : key === yesterday
          ? 'Yesterday'
          : created.toLocaleDateString(undefined, {
              month: 'long',
              day: 'numeric',
              year: created.getFullYear() === now.getFullYear() ? undefined : 'numeric',
            });
    const existing = groups.get(key) ?? { label, items: [] };
    existing.items.push(item);
    groups.set(key, existing);
  }

  return [...groups.values()];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}
