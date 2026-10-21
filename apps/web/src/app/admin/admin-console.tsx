'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  LiveRegion,
  Spinner,
} from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * The operator console (PROJECT.md section 12 Phase 9).
 *
 * Everything here is a real operation, not a read-only dashboard:
 *
 *  - replaying a failed job re-reserves credits from the user's wallet;
 *  - replaying an outbox event re-queues delivery;
 *  - adjusting credits writes a ledger row and an audit row.
 *
 * The page therefore says what each button will do before it is pressed, and
 * asks for confirmation on the credit adjustment. An operator console that makes
 * money move on a single misplaced click is a liability.
 *
 * A workspace OWNER sees their own workspaces' rows; a global `ADMIN` sees
 * everything. The server enforces both; this page does not filter, because a
 * client-side filter is not access control.
 */
export function AdminConsole() {
  const api = useApi();
  const [announcement, setAnnouncement] = useState('');

  const dlq = useQuery({ queryKey: ['admin', 'dlq'], queryFn: () => api.admin.dlq() });
  const outbox = useQuery({ queryKey: ['admin', 'outbox'], queryFn: () => api.admin.outbox() });

  const forbidden = [dlq.error, outbox.error].some(
    (error) => error instanceof ApiClientError && error.status === 403,
  );

  const replayJob = useMutation({
    mutationFn: (jobId: string) => api.admin.replayJob(jobId, 'replayed from the admin console'),
    onSuccess: (result) => {
      setAnnouncement(`Job ${result.jobId} was re-reserved and re-queued.`);
      void dlq.refetch();
    },
    onError: (error: unknown) => setAnnouncement(messageOf(error)),
  });

  const replayOutbox = useMutation({
    mutationFn: (eventId: string) => api.admin.replayOutbox(eventId),
    onSuccess: (result) => {
      setAnnouncement(`Event ${result.eventId} is back in the pending set.`);
      void outbox.refetch();
    },
    onError: (error: unknown) => setAnnouncement(messageOf(error)),
  });

  const [reconcile, setReconcile] = useState<
    | {
        checked: number;
        drifted: number;
        drift: {
          userId: string;
          walletTotal: number;
          ledgerAvailable: number;
          ledgerReserved: number;
        }[];
      }
    | undefined
  >();

  const reconciliation = useMutation({
    mutationFn: () => api.admin.reconcile(),
    onSuccess: (result) => {
      setReconcile(result);
      setAnnouncement(
        result.drifted === 0
          ? `Checked ${result.checked} wallets; no drift.`
          : `Checked ${result.checked} wallets; ${result.drifted} drifted.`,
      );
    },
    onError: (error: unknown) => setAnnouncement(messageOf(error)),
  });

  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [adjustError, setAdjustError] = useState<string | undefined>();

  const amountNumber = Number(amount);
  const amountError =
    amount !== '' && (!Number.isInteger(amountNumber) || amountNumber === 0)
      ? 'Enter a non-zero whole number of credits.'
      : undefined;

  const adjust = useMutation({
    mutationFn: () =>
      api.admin.adjustCredits({
        userId: userId.trim(),
        amount: amountNumber,
        reason: reason.trim(),
        ...(referenceId.trim() === '' ? {} : { referenceId: referenceId.trim() }),
      }),
    onSuccess: (result) => {
      setAnnouncement(
        result.applied
          ? `${result.amount > 0 ? 'Granted' : 'Removed'} ${Math.abs(result.amount)} credits. New balance: ${result.balance.available} available, ${result.balance.reserved} reserved.`
          : `That reference id was already applied; nothing changed. Current balance: ${result.balance.available} available, ${result.balance.reserved} reserved.`,
      );
      setAmount('');
      setReason('');
      setReferenceId('');
      setAdjustError(undefined);
    },
    onError: (error: unknown) => {
      setAdjustError(messageOf(error));
      setAnnouncement('The adjustment was refused.');
    },
  });

  if (forbidden) {
    return (
      <>
        <h1>Operator console</h1>
        <EmptyState
          title="Operator access required"
          description="This page is available to a global ADMIN, or to the OWNER of a workspace. It operates on real credits and real deliveries."
        />
      </>
    );
  }

  if (dlq.isLoading || outbox.isLoading) {
    return <Spinner label="Loading the operator console" />;
  }

  return (
    <>
      <h1>Operator console</h1>
      <p className={styles.cardDescription}>
        The dead-letter queue is the set of jobs and events that were given up on. Replaying a job
        re-reserves its credits; replaying an event only re-delivers it.
      </p>

      <LiveRegion message={announcement} />

      <Card
        title="Failed generation jobs"
        description="FAILED, refunded, and never charged. Replay re-reserves the original amount."
      >
        {dlq.isError && (
          <ErrorNotice
            message="Could not load the dead-letter queue."
            onRetry={() => void dlq.refetch()}
          />
        )}

        {dlq.data !== undefined && dlq.data.length === 0 && (
          <EmptyState title="No failed jobs" description="Nothing has exhausted its attempts." />
        )}

        {dlq.data !== undefined && dlq.data.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className={styles.numeric}>
                    Credits
                  </th>
                  <th scope="col">Error</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {dlq.data.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <code>{job.id.slice(0, 8)}</code>
                    </td>
                    <td>
                      {job.kind} <span className={styles.cardDescription}>· {job.stage}</span>
                    </td>
                    <td className={styles.numeric}>{job.creditsReserved}</td>
                    <td>{job.error ?? '—'}</td>
                    <td>{new Date(job.createdAt).toLocaleString()}</td>
                    <td>
                      <Button
                        type="button"
                        busy={replayJob.isPending && replayJob.variables === job.id}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Replay this job? It will reserve ${job.creditsReserved} credits from the owner's wallet again.`,
                            )
                          ) {
                            replayJob.mutate(job.id);
                          }
                        }}
                      >
                        Replay
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Abandoned outbox events"
        description="Undelivered after the retry limit. Replaying only re-queues; it does not re-charge."
      >
        {outbox.isError && (
          <ErrorNotice
            message="Could not load abandoned events."
            onRetry={() => void outbox.refetch()}
          />
        )}

        {outbox.data !== undefined && outbox.data.length === 0 && (
          <EmptyState
            title="No abandoned events"
            description="The relay has delivered everything."
          />
        )}

        {outbox.data !== undefined && outbox.data.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Aggregate</th>
                  <th scope="col" className={styles.numeric}>
                    Attempts
                  </th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {outbox.data.map((event) => (
                  <tr key={event.id}>
                    <td>
                      {event.eventType}{' '}
                      <span className={styles.cardDescription}>· {event.id.slice(0, 8)}</span>
                    </td>
                    <td>
                      {event.aggregateType} <code>{event.aggregateId.slice(0, 8)}</code>
                    </td>
                    <td className={styles.numeric}>{event.attempts}</td>
                    <td>
                      <Button
                        type="button"
                        busy={replayOutbox.isPending && replayOutbox.variables === event.id}
                        onClick={() => replayOutbox.mutate(event.id)}
                      >
                        Replay
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Credit reconciliation"
        description="Rebuilds each wallet's available and reserved balances from the ledger's buckets."
        actions={
          <Button
            type="button"
            variant="primary"
            busy={reconciliation.isPending}
            onClick={() => reconciliation.mutate()}
          >
            Run reconciliation
          </Button>
        }
      >
        {reconcile === undefined ? (
          <p className={styles.cardDescription}>
            On demand only. It scans every wallet in scope, so it is not part of a page load.
          </p>
        ) : (
          <>
            <p>
              <Badge tone={reconcile.drifted === 0 ? 'good' : 'bad'}>
                {reconcile.drifted === 0 ? 'No drift' : `${reconcile.drifted} drifted`}
              </Badge>{' '}
              Checked {reconcile.checked} wallets.
            </p>
            {reconcile.drift.length > 0 && (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col" className={styles.numeric}>
                        Wallet total
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Ledger available
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Ledger reserved
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconcile.drift.map((entry) => (
                      <tr key={entry.userId}>
                        <td>
                          <code>{entry.userId}</code>
                        </td>
                        <td className={styles.numeric}>{entry.walletTotal}</td>
                        <td className={styles.numeric}>{entry.ledgerAvailable}</td>
                        <td className={styles.numeric}>{entry.ledgerReserved}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="Adjust credits"
        description="Writes a ledger entry and an audit entry in one transaction. The reason is required."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setAdjustError(undefined);

            if (userId.trim() === '' || amountError !== undefined || reason.trim().length < 3) {
              setAdjustError('A user id, a non-zero integer amount and a reason are required.');
              return;
            }

            adjust.mutate();
          }}
        >
          <Field label="User id" id="adjust-user" hint="The UUID shown in the user's account.">
            {(props) => (
              <input
                id={props.id}
                aria-describedby={props.describedBy}
                aria-invalid={props.invalid}
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>

          <Field
            label="Amount"
            id="adjust-amount"
            hint="Positive grants credits; negative removes them. Never zero."
            error={amountError ?? adjustError}
          >
            {(props) => (
              <input
                id={props.id}
                aria-describedby={props.describedBy}
                aria-invalid={props.invalid}
                type="number"
                step={1}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            )}
          </Field>

          <Field label="Reason" id="adjust-reason" hint="Recorded in the ledger and the audit log.">
            {(props) => (
              <input
                id={props.id}
                aria-describedby={props.describedBy}
                aria-invalid={props.invalid}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={3}
                maxLength={500}
                required
              />
            )}
          </Field>

          <Field
            label="Reference id"
            id="adjust-reference"
            hint="Optional. Retrying with the same reference does not apply the adjustment twice."
          >
            {(props) => (
              <input
                id={props.id}
                aria-describedby={props.describedBy}
                aria-invalid={props.invalid}
                value={referenceId}
                onChange={(event) => setReferenceId(event.target.value)}
                maxLength={200}
              />
            )}
          </Field>

          <Button type="submit" variant="danger" busy={adjust.isPending}>
            Apply adjustment
          </Button>
        </form>
      </Card>
    </>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  return error instanceof Error ? error.message : 'The operation failed.';
}
