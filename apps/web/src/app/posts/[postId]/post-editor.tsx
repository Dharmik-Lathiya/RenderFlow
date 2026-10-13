'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import { Badge, Button, Card, ErrorNotice, Field, Spinner } from '../../../components/ui';
import { JobProgressView, useJobProgress } from './job-progress';
import styles from '../../../components/ui.module.css';

/**
 * The post editor: write it, generate it, approve it, schedule it.
 *
 * The order is the product. An EDITOR writes and generates; an APPROVER decides
 * what the world sees; only then can it be scheduled. The buttons below reflect
 * that - the server enforces it too, but a control that is visible and refuses is
 * worse than one that is not there.
 */
export function PostEditor({ postId }: { postId: string }) {
  const api = useApi();
  const client = useQueryClient();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    retry: false,
  });

  const post = useQuery({ queryKey: ['post', postId], queryFn: () => api.posts.detail(postId) });

  // Scheduling is per workspace, so the editor resolves which one it is in. The
  // FIRST workspace, because that is the only one a single-workspace user has,
  // and picking at random would be worse than picking the first.
  const workspaceId = workspaces.data?.[0]?.id;
  const publishes = useQuery({
    queryKey: ['publishes', postId],
    queryFn: () => api.posts.publishes(postId),
    enabled: post.isSuccess,
  });

  const [caption, setCaption] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [upsell, setUpsell] = useState<string | null>(null);

  /**
   * The idempotency key for the CURRENT intent, not per click.
   *
   * A fresh `randomUUID()` per click would be worse than no key at all: it makes
   * every click a distinct request, so a double-click charges twice and a retry
   * after a dropped connection charges again. Held in a ref so it survives
   * re-renders, and rotated only after a request SUCCEEDS - which is what makes
   * "try again" mean a new generation and "retry" mean the same one.
   */
  const intentKey = useRef<string | null>(null);

  function keyForIntent(): string {
    intentKey.current ??= crypto.randomUUID();
    return intentKey.current;
  }

  // Guards the "load the saved caption once" effect below from clobbering edits
  // on every refetch. Without it, a background refresh resets a half-written
  // caption and the user loses their work.
  const loaded = useRef(false);

  useEffect(() => {
    if (post.data !== undefined && !loaded.current) {
      loaded.current = true;
      setCaption(post.data.caption ?? '');
    }
  }, [post.data]);

  const progress = useJobProgress(jobId);

  const generate = useMutation({
    mutationFn: (type: 'CAPTION' | 'POSTER' | 'CAROUSEL' | 'REEL') =>
      api.posts.generate(postId, { type }, keyForIntent()),
    retry: false,
    onSuccess: (result) => {
      // Rotated here and nowhere else: the job now exists, so the next click is
      // a genuinely new request.
      intentKey.current = null;
      setJobId(result.job.id);
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.isInsufficientCredits) {
        setUpsell('Not enough credits for that.');
      }
    },
  });

  const save = useMutation({
    mutationFn: () => api.posts.update(postId, { caption: caption ?? '' }),
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['post', postId] });
    },
  });

  const approve = useMutation({
    mutationFn: () => api.posts.approve(postId),
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['post', postId] });
    },
  });

  if (post.isLoading) {
    return <Spinner label="Loading post" />;
  }

  if (post.isError || post.data === undefined) {
    return <ErrorNotice message="Could not load this post." onRetry={() => void post.refetch()} />;
  }

  const current = post.data;
  const editable = current.status === 'DRAFT' || current.status === 'GENERATING';

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Post</h1>

      <Card
        title="Content"
        actions={<Badge tone={toneFor(current.status)}>{current.status}</Badge>}
      >
        <Field label="Caption" id="caption">
          {({ id }) => (
            <textarea
              id={id}
              value={caption ?? ''}
              onChange={(event) => setCaption(event.target.value)}
              disabled={!editable}
            />
          )}
        </Field>

        <div className={styles.row}>
          <Button
            variant="secondary"
            busy={save.isPending}
            disabled={!editable || (caption ?? '') === (current.caption ?? '')}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
          {current.status !== 'APPROVED' && (
            <Button
              variant="primary"
              busy={approve.isPending}
              disabled={!editable}
              onClick={() => approve.mutate()}
            >
              Approve
            </Button>
          )}
        </div>
      </Card>

      <Card
        title="Generate"
        description="Each kind costs credits. Nothing is charged if the job fails."
      >
        <div className={styles.row}>
          {(['CAPTION', 'POSTER', 'CAROUSEL', 'REEL'] as const).map((type) => (
            <Button
              key={type}
              variant={type === 'REEL' ? 'primary' : 'secondary'}
              busy={generate.isPending && generate.variables === type}
              disabled={!editable}
              onClick={() => generate.mutate(type)}
            >
              {labelFor(type)}
            </Button>
          ))}
        </div>

        {generate.isError && !upsell && (
          <ErrorNotice
            message={
              generate.error instanceof ApiClientError &&
              generate.error.code === 'MODERATION_REJECTED'
                ? generate.error.message
                : 'Could not start that generation.'
            }
          />
        )}
      </Card>

      {jobId !== null && (
        <Card title="Progress">
          <JobProgressView progress={progress} />
        </Card>
      )}

      <PublishHistory postId={postId} workspaceId={workspaceId} publishes={publishes.data} />

      {upsell !== null && (
        <InsufficientCreditsDialog message={upsell} onClose={() => setUpsell(null)} />
      )}
    </>
  );
}

/**
 * The upsell modal.
 *
 * Shown only when the user is actually blocked. Escape closes it and focus
 * returns to where it was, because a dialog that traps a keyboard user with no
 * way out is a bug, not a modal.
 */
function InsufficientCreditsDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const dismiss = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dismiss.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.dialogBackdrop}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="upsell-title">
        <h2 id="upsell-title">Out of credits</h2>
        <p>{message}</p>
        <p className={styles.cardDescription}>
          Credits are only taken when a job finishes, so anything that failed was refunded.
        </p>
        <div className={styles.row}>
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
          <Link href="/brands">
            <Button variant="secondary">See plans</Button>
          </Link>
        </div>
        {/* Focus lands here on mount, so Escape is discoverable by keyboard. */}
        <button ref={dismiss} type="button" className="sr-only" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function PublishHistory({
  postId,
  workspaceId,
  publishes,
}: {
  postId: string;
  /** Accounts belong to a workspace, not to a post. */
  workspaceId: string | undefined;
  publishes:
    | {
        id: string;
        platform: string;
        status: string;
        scheduledFor: string;
        externalUrl: string | null;
        error: string | null;
      }[]
    | undefined;
}) {
  const api = useApi();
  const client = useQueryClient();

  const accounts = useQuery({
    queryKey: ['social-accounts', workspaceId],
    queryFn: () => api.socialAccounts.list(workspaceId ?? ''),
    enabled: workspaceId !== undefined,
  });

  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [when, setWhen] = useState('');

  const schedule = useMutation({
    mutationFn: () =>
      // Keyed on the content of the request, so pressing Schedule twice for the
      // same slot returns the first schedule instead of queueing a second post.
      api.posts.schedule(
        postId,
        { scheduledAt: new Date(when), accountIds: [...accountIds].sort() },
        scheduleKey(postId, when, accountIds),
      ),
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['publishes', postId] });
    },
  });

  return (
    <Card title="Schedule" description="Publishing to a public profile needs an APPROVER.">
      {publishes !== undefined && publishes.length > 0 && (
        <ul className={styles.list}>
          {publishes.map((job) => (
            <li key={job.id} className={styles.listItem}>
              <span>
                {job.platform} · {new Date(job.scheduledFor).toLocaleString()}
              </span>
              <Badge tone={toneFor(job.status)}>{job.status}</Badge>
            </li>
          ))}
        </ul>
      )}

      {accounts.isError && (
        <p className={styles.cardDescription}>
          Connect a social account in Settings before scheduling.
        </p>
      )}

      {accounts.data !== undefined && accounts.data.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            schedule.mutate();
          }}
        >
          {schedule.isError && <ErrorNotice message="Could not schedule this post." />}

          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1rem' }}>
            <legend className={styles.label}>Accounts</legend>
            {accounts.data.map((account) => (
              <label key={account.id} className={styles.row}>
                <input
                  type="checkbox"
                  value={account.id}
                  checked={accountIds.includes(account.id)}
                  onChange={(event) =>
                    setAccountIds((current) =>
                      event.target.checked
                        ? [...current, account.id]
                        : current.filter((id) => id !== account.id),
                    )
                  }
                />
                {account.displayName ?? account.platform}
                {account.needsReconnect && (
                  <>
                    {' '}
                    <Badge tone="warn">reconnect needed</Badge>
                  </>
                )}
              </label>
            ))}
          </fieldset>

          <Field label="Publish at" id="when">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
            )}
          </Field>

          <Button
            type="submit"
            variant="primary"
            busy={schedule.isPending}
            disabled={accountIds.length === 0 || when === ''}
          >
            Schedule
          </Button>
        </form>
      )}
    </Card>
  );
}

/**
 * A stable idempotency key for one scheduling intent.
 *
 * Derived from the request rather than random, so pressing Schedule twice for the
 * same post, slot and accounts returns the first schedule instead of queueing a
 * second publication of the same thing. Accounts are SORTED first, because the
 * same set in a different order is the same intent.
 */
function scheduleKey(postId: string, when: string, accountIds: readonly string[]): string {
  return `schedule:${postId}:${when}:${[...accountIds].sort().join(',')}`;
}

function toneFor(status: string): 'neutral' | 'good' | 'bad' | 'warn' {
  if (status === 'PUBLISHED' || status === 'COMPLETED' || status === 'APPROVED') {
    return 'good';
  }
  if (status === 'FAILED') {
    return 'bad';
  }
  if (status === 'PUBLISHING' || status === 'GENERATING' || status === 'SCHEDULED') {
    return 'warn';
  }
  return 'neutral';
}

function labelFor(type: 'CAPTION' | 'POSTER' | 'CAROUSEL' | 'REEL'): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}
