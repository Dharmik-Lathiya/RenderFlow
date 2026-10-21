'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useApi } from '../../lib/providers';
import type { ScheduledPost } from '@renderflow/api-client';
import { Button, Card, EmptyState, ErrorNotice, LiveRegion, Spinner } from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * The content calendar (PROJECT.md Phase 8 gap, Phase 9).
 *
 * A month grid of scheduled posts with drag-to-reschedule. The drag is a
 * convenience, not the only path: every chip also carries a date input and a
 * cancel button, so the same actions work with a keyboard and a screen reader.
 * A drag-only calendar is inaccessible to a large fraction of the people who
 * might use it, and "it has a mouse handler" is not a feature.
 *
 * Rescheduling calls `PATCH /posts/:id/schedule`, which updates the row the
 * publisher claims from. It does not create a new publish job, does not change
 * which accounts the post goes to, and does not touch credits.
 */
export function Calendar() {
  const api = useApi();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
  });

  const workspaceId = workspaces.data?.[0]?.id;

  const grid = buildGrid(month);

  const scheduled = useQuery({
    queryKey: ['calendar', workspaceId, grid.from.toISOString(), grid.to.toISOString()],
    queryFn: () =>
      api.posts.scheduled(workspaceId as string, {
        from: grid.from.toISOString(),
        to: grid.to.toISOString(),
      }),
    enabled: workspaceId !== undefined,
  });

  const reschedule = useMutation({
    mutationFn: (input: { postId: string; at: Date }) =>
      api.posts.reschedule(input.postId, input.at.toISOString()),
    onSuccess: (result) => {
      setAnnouncement(
        result.updated === 0
          ? 'Nothing moved: the post is already publishing or no longer scheduled.'
          : `Post moved to ${new Date(result.scheduledAt).toLocaleString()}.`,
      );
      void scheduled.refetch();
    },
    onError: (error: unknown) => {
      setAnnouncement(error instanceof Error ? error.message : 'Could not move the post.');
    },
  });

  const cancel = useMutation({
    mutationFn: (postId: string) => api.posts.cancelSchedule(postId),
    onSuccess: (result) => {
      setAnnouncement(
        result.cancelled === 0
          ? 'Nothing to cancel: the post has already been published.'
          : `Cancelled ${result.cancelled} scheduled ${result.cancelled === 1 ? 'delivery' : 'deliveries'}.`,
      );
      void scheduled.refetch();
    },
    onError: (error: unknown) => {
      setAnnouncement(error instanceof Error ? error.message : 'Could not cancel the post.');
    },
  });

  if (workspaces.isLoading) {
    return <Spinner label="Loading your calendar" />;
  }

  if (workspaces.isError) {
    return (
      <ErrorNotice
        message="Could not load your workspace."
        onRetry={() => void workspaces.refetch()}
      />
    );
  }

  if (workspaceId === undefined) {
    return (
      <EmptyState
        title="No workspace yet"
        description="Create a brand and a campaign, then schedule its posts."
      />
    );
  }

  const byDay = groupByDay(scheduled.data ?? []);

  const moveTo = (post: ScheduledPost, day: Date): void => {
    if (post.scheduledAt === null) {
      return;
    }

    const current = new Date(post.scheduledAt);
    const at = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      current.getHours(),
      current.getMinutes(),
      current.getSeconds(),
    );

    // A move to the same instant is a drag that ended where it started. Skipping
    // it avoids a pointless round trip and a confusing "Post moved" announcement.
    if (Math.abs(at.getTime() - current.getTime()) < 60_000) {
      return;
    }

    reschedule.mutate({ postId: post.id, at });
  };

  return (
    <>
      <h1>Calendar</h1>
      <p className={styles.cardDescription}>
        Drag a post to another day, or use the date field on each card. Times keep their hour and
        minute when a post moves. Only approved posts can be scheduled.
      </p>

      <LiveRegion message={announcement} />

      <Card>
        <div className={styles.monthHeader}>
          <div className={styles.row}>
            <Button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              ←
            </Button>
            <h2 aria-live="polite">
              {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </h2>
            <Button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(addMonths(month, 1))}
            >
              →
            </Button>
            <Button type="button" onClick={() => setMonth(startOfMonth(new Date()))}>
              Today
            </Button>
          </div>
          {scheduled.isFetching && <span className={styles.cardDescription}>Refreshing…</span>}
        </div>

        {scheduled.isError && (
          <ErrorNotice
            message="Could not load scheduled posts."
            onRetry={() => void scheduled.refetch()}
          />
        )}

        <div className={styles.calendarWrap}>
          <div className={styles.calendarGrid} role="grid" aria-label="Scheduled posts by day">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
              <div key={label} className={styles.calendarHead} role="columnheader">
                {label}
              </div>
            ))}

            {grid.days.map((day) => {
              const key = dayKey(day);
              const posts = byDay.get(key) ?? [];
              const muted = day.getMonth() !== month.getMonth();
              const today = dayKey(day) === dayKey(new Date());

              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-label={day.toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}
                  className={[
                    styles.calendarCell,
                    muted ? styles.calendarCellMuted : '',
                    today ? styles.calendarCellToday : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onDragOver={(event) => {
                    // Without preventDefault the browser refuses the drop.
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const postId = event.dataTransfer.getData('text/plain') || dragging;
                    setDragging(null);

                    const post = (scheduled.data ?? []).find(
                      (candidate) => candidate.id === postId,
                    );

                    if (post !== undefined) {
                      moveTo(post, day);
                    }
                  }}
                >
                  <p className={styles.calendarDay}>{day.getDate()}</p>

                  <ul className={styles.calendarChips}>
                    {posts.map((post) => (
                      <li key={post.id}>
                        <div
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/plain', post.id);
                            event.dataTransfer.effectAllowed = 'move';
                            setDragging(post.id);
                          }}
                          onDragEnd={() => setDragging(null)}
                          className={[styles.chip, dragging === post.id ? styles.chipDragging : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <strong>{post.type}</strong>
                          <br />
                          {post.scheduledAt !== null &&
                            new Date(post.scheduledAt).toLocaleTimeString(undefined, {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          <br />
                          <span className={styles.cardDescription}>{post.brandName}</span>
                          <div className={styles.chipMove}>
                            <label>
                              <span className={styles.cardDescription}>Move</span>{' '}
                              <input
                                type="date"
                                aria-label={`Move ${post.type} post to another day`}
                                value={
                                  post.scheduledAt !== null
                                    ? dayKey(new Date(post.scheduledAt))
                                    : ''
                                }
                                onChange={(event) => {
                                  const value = event.target.value;

                                  if (value === '') {
                                    return;
                                  }

                                  const parts = value.split('-').map(Number);
                                  const [year, monthIndex, dayNumber] = parts;

                                  if (
                                    year === undefined ||
                                    monthIndex === undefined ||
                                    dayNumber === undefined ||
                                    !Number.isFinite(year) ||
                                    !Number.isFinite(monthIndex) ||
                                    !Number.isFinite(dayNumber)
                                  ) {
                                    return;
                                  }

                                  moveTo(post, new Date(year, monthIndex - 1, dayNumber));
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              className={styles.chipCancel}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Cancel the remaining scheduled deliveries for this post?',
                                  )
                                ) {
                                  cancel.mutate(post.id);
                                }
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>

        {scheduled.data !== undefined && scheduled.data.length === 0 && (
          <EmptyState
            title="Nothing scheduled this month"
            description="Approve a post, then schedule it to a connected account to see it here."
          />
        )}
      </Card>
    </>
  );
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/**
 * Six weeks starting on the Sunday on or before the first of the month.
 *
 * Fixed at 42 cells so the grid does not change height between months; a
 * calendar that jumps is a calendar that hides the button you were about to
 * press.
 */
function buildGrid(month: Date): { days: Date[]; from: Date; to: Date } {
  const first = startOfMonth(month);
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay());

  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return day;
  });

  const end = days[days.length - 1] as Date;
  const to = new Date(end);
  to.setHours(23, 59, 59, 999);

  return { days, from: start, to };
}

/** Local calendar day, not UTC: the grid is the user's calendar. */
function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function groupByDay(posts: readonly ScheduledPost[]): Map<string, ScheduledPost[]> {
  const byDay = new Map<string, ScheduledPost[]>();

  for (const post of posts) {
    if (post.scheduledAt === null) {
      continue;
    }

    const key = dayKey(new Date(post.scheduledAt));
    const existing = byDay.get(key) ?? [];
    existing.push(post);
    byDay.set(key, existing);
  }

  return byDay;
}
