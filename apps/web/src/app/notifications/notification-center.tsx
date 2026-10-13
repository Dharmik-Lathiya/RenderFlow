'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useApi } from '../../lib/providers';
import { Badge, Button, Card, EmptyState, ErrorNotice, Spinner } from '../../components/ui';
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

  const unread = notifications.data?.filter((n) => n.readAt === null) ?? [];

  return (
    <>
      <h1>Notifications</h1>

      <Card
        title="Recent"
        description="Failed publishes land here with what went wrong."
        actions={
          <div className={styles.row}>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => setUnreadOnly(event.target.checked)}
              />
              Unread only
            </label>
            <Button
              variant="secondary"
              busy={markAll.isPending}
              disabled={unread.length === 0}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
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

        {notifications.data !== undefined && notifications.data.length === 0 && (
          <EmptyState
            title={unreadOnly ? 'Nothing unread' : 'No notifications'}
            description="A publish that fails tells you here rather than failing quietly."
          />
        )}

        {notifications.data !== undefined && notifications.data.length > 0 && (
          <ul className={styles.list}>
            {notifications.data.map((notification) => (
              <li key={notification.id} className={styles.listItem}>
                <span>
                  <strong>{notification.title}</strong>
                  <span className={styles.cardDescription}> — {notification.body}</span>
                </span>
                {notification.readAt === null ? (
                  <Button
                    variant="ghost"
                    busy={markRead.isPending}
                    onClick={() => markRead.mutate(notification.id)}
                  >
                    Mark read
                  </Button>
                ) : (
                  <Badge>read</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
