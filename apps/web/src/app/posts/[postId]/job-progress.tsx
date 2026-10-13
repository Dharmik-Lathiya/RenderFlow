'use client';

import { useEffect, useRef, useState } from 'react';

import type { Job } from '@renderflow/api-client';

import { Badge, Button, LiveRegion } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Live generation progress.
 *
 * The SSE stream is the reason this is a hook and not a `setInterval`: the API
 * pushes a checkpoint per stage (PROJECT.md section 4), and polling would show
 * the same thing the pipeline already knows, a second later, at the cost of a
 * request per tick per user.
 *
 * Three things it has to get right, all of which are invisible until they are
 * wrong:
 *
 *  - **It reconnects.** A dropped stream is the normal case, not the exception -
 *    a phone in a lift, a laptop lid. The effect re-subscribes, and the poll
 *    below covers the gap.
 *  - **It falls back.** If the browser refuses the stream (no EventSource, a
 *    proxy that buffers), progress still updates by polling. A feature that
 *    degrades to nothing is worse than one that degrades.
 *  - **It announces, not just renders.** A progress bar moving is invisible to a
 *    screen reader, so every stage change goes to a live region.
 */

/** Pipeline stages in the order a job runs them. */
const STAGES = ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER'] as const;

export interface JobProgress {
  job: Job | null;
  stage: string | null;
  completed: string[];
  /** True while the stream or the poll is waiting on the first byte. */
  connecting: boolean;
}

export function useJobProgress(jobId: string | null): JobProgress {
  const [job, setJob] = useState<Job | null>(null);
  const [connecting, setConnecting] = useState(false);

  /**
   * Kept in a ref, not state: changing it must NOT re-run the effect that
   * subscribes, or every checkpoint would tear down and rebuild the stream.
   */
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (jobId === null) {
      setJob(null);
      seen.current = new Set();
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    setConnecting(true);

    const absorb = (next: Job): void => {
      if (cancelled) {
        return;
      }
      // Checkpoints arrive by stage name. Adding them to a set rather than
      // assigning means a redelivered or replayed event does not move the bar
      // backwards.
      for (const stage of next.completedStages) {
        seen.current.add(stage);
      }
      setJob({ ...next, completedStages: [...seen.current] });
      setConnecting(false);
    };

    /**
     * The backstop, and the only path if EventSource is unavailable.
     *
     * `pollMs` is generous on purpose: this exists to catch a missed event, not
     * to be the primary mechanism.
     */
    const startPolling = (): void => {
      if (poll !== null) {
        return;
      }
      poll = setInterval(() => {
        void fetch(`/api/v1/jobs/${jobId}`, { credentials: 'include' })
          .then((response) => (response.ok ? response.json() : null))
          .then((body: unknown) => {
            if (body !== null && typeof body === 'object') {
              absorb(body as Job);
            }
          })
          .catch(() => {
            // Offline or mid-restart. The next tick tries again; there is
            // nothing useful to say on every failure.
          });
      }, 2_000);
    };

    if (typeof window !== 'undefined' && typeof EventSource !== 'function') {
      // No EventSource at all. Polling is not a degraded experience here, it is
      // the whole experience, and pretending otherwise would leave the bar stuck
      // at zero with no explanation.
      startPolling();
      setConnecting(false);
    } else {
      source = new EventSource(`/api/v1/jobs/${jobId}/events`, { withCredentials: true });

      source.addEventListener('progress', (event) => {
        try {
          absorb(JSON.parse((event as MessageEvent<string>).data) as Job);
        } catch {
          // A malformed frame is the server's problem, not the user's; the poll
          // will produce a correct one shortly.
        }
      });

      source.addEventListener('error', () => {
        // Fires on drop AND on a refused connection, so polling starts either
        // way. `source` is left to be closed by the cleanup below.
        startPolling();
      });

      source.addEventListener('done', () => {
        // The terminal event ends the stream. Without closing it the browser
        // keeps a connection open to a job that will never emit again.
        source?.close();
        source = null;
        setConnecting(false);
      });
    }

    return () => {
      cancelled = true;
      source?.close();
      if (poll !== null) {
        clearInterval(poll);
      }
    };
  }, [jobId]);

  const completed = job?.completedStages ?? [];

  return {
    job,
    stage: job?.stage ?? null,
    completed,
    connecting,
  };
}

export function JobProgressView({
  progress,
  onCancel,
}: {
  progress: JobProgress;
  onCancel?: () => void;
}) {
  const { job, completed, connecting } = progress;

  if (job === null) {
    return connecting ? <p className={styles.cardDescription}>Starting…</p> : null;
  }

  const terminal = job.status === 'COMPLETED' || job.status === 'FAILED';
  const done = completed.length;

  return (
    <div>
      <div className={styles.row} style={{ justifyContent: 'space-between' }}>
        <Badge tone={job.status === 'FAILED' ? 'bad' : terminal ? 'good' : 'neutral'}>
          {job.status}
        </Badge>
        {onCancel !== undefined && !terminal && (
          <Button variant="ghost" onClick={onCancel}>
            Stop
          </Button>
        )}
      </div>

      {!terminal && (
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={STAGES.length}
          aria-valuenow={done}
          aria-label="Generation progress"
        >
          <div
            className={styles.progressFill}
            style={{ width: `${Math.round((done / STAGES.length) * 100)}%` }}
          />
        </div>
      )}

      <ol className={styles.list}>
        {STAGES.map((stage) => {
          const reached = completed.includes(stage);
          const current = !terminal && job.stage === stage;

          return (
            <li key={stage} className={styles.listItem}>
              <span>{stage.toLowerCase()}</span>
              <Badge tone={reached ? 'good' : current ? 'warn' : 'neutral'}>
                {reached ? 'done' : current ? 'running' : 'waiting'}
              </Badge>
            </li>
          );
        })}
      </ol>

      {job.error !== null && <ErrorNotice message={job.error} />}

      {/*
        Announced, not just drawn. A progress bar moving is invisible to a
        screen reader, and this is the only signal that something is happening.
      */}
      <LiveRegion
        message={
          terminal
            ? job.status === 'COMPLETED'
              ? 'Generation complete'
              : `Generation failed: ${job.error ?? 'unknown reason'}`
            : `${job.stage ?? 'starting'} running, ${done} of ${STAGES.length} stages complete`
        }
      />
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className={styles.errorNotice} role="alert">
      <p>{message}</p>
    </div>
  );
}
