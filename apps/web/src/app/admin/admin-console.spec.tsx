import { fireEvent, screen, waitFor } from '@testing-library/react';

import { AdminConsole } from './admin-console';
import { renderWithProviders, stubApi } from '../../test/harness';

/**
 * The operator console.
 *
 * The point of these tests is that the dangerous actions are not one click away
 * from an accident: replay asks for confirmation because it re-charges the user,
 * and the adjustment form refuses a fractional amount before it reaches the API.
 * The server enforces both too; this is the half the operator sees.
 */

const JOB = {
  id: 'job-12345678',
  postId: 'p1',
  kind: 'REEL',
  stage: 'IMAGE',
  status: 'FAILED',
  attempts: 3,
  maxAttempts: 3,
  creditsReserved: 30,
  refunded: true,
  captured: false,
  error: 'IMAGE provider timed out',
  createdAt: '2026-06-01T10:00:00.000Z',
  finishedAt: '2026-06-01T10:05:00.000Z',
};

const EVENT = {
  id: 'event-12345678',
  aggregateType: 'JOB',
  aggregateId: 'job-12345678',
  eventType: 'job.created',
  attempts: 10,
  payload: {},
};

const BALANCE = {
  userId: 'member-1',
  amount: 25,
  balance: { userId: 'member-1', available: 75, reserved: 0, total: 75 },
  referenceId: null,
  applied: true,
};

describe('AdminConsole', () => {
  it('lists the dead-letter queue and abandoned events', async () => {
    const { client } = stubApi({
      'GET /admin/dlq': { body: { jobs: [JOB] } },
      'GET /admin/dlq/outbox': { body: { events: [EVENT] } },
    });

    renderWithProviders(<AdminConsole />, client);

    expect(await screen.findByRole('heading', { name: 'Operator console' })).toBeInTheDocument();
    expect(await screen.findByText(/IMAGE provider timed out/)).toBeInTheDocument();
    expect(screen.getByText('job.created')).toBeInTheDocument();
  });

  it('re-charges on replay only after confirmation', async () => {
    const { client, calls } = stubApi({
      'GET /admin/dlq': { body: { jobs: [JOB] } },
      'GET /admin/dlq/outbox': { body: { events: [] } },
      'POST /admin/dlq/{jobId}/replay': { body: { jobId: 'job-new', requeued: true } },
    });

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<AdminConsole />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('reserve 30 credits'));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
  });

  it('replays an outbox event without a confirmation, because it moves no credits', async () => {
    const { client, calls } = stubApi({
      'GET /admin/dlq': { body: { jobs: [] } },
      'GET /admin/dlq/outbox': { body: { events: [EVENT] } },
      'POST /admin/dlq/outbox/{eventId}/replay': {
        body: { eventId: EVENT.id, replayed: true },
      },
    });

    renderWithProviders(<AdminConsole />, client);
    fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url === `/admin/dlq/outbox/${EVENT.id}/replay`)).toBe(true);
    });
  });

  it('turns a 403 into an explanation instead of an empty page', async () => {
    const { client } = stubApi({
      'GET /admin/dlq': {
        status: 403,
        body: { code: 'FORBIDDEN', message: 'Operator role required' },
      },
      'GET /admin/dlq/outbox': {
        status: 403,
        body: { code: 'FORBIDDEN', message: 'Operator role required' },
      },
    });

    renderWithProviders(<AdminConsole />, client);

    expect(await screen.findByText('Operator access required')).toBeInTheDocument();
  });

  it('refuses a fractional credit amount locally', async () => {
    const { client, calls } = stubApi({
      'GET /admin/dlq': { body: { jobs: [] } },
      'GET /admin/dlq/outbox': { body: { events: [] } },
    });

    renderWithProviders(<AdminConsole />, client);

    fireEvent.change(await screen.findByLabelText('User id'), { target: { value: 'member-1' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'rounding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    expect(
      await screen.findByText('Enter a non-zero whole number of credits.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('submits a valid adjustment and reports the new balance', async () => {
    const { client, calls } = stubApi({
      'GET /admin/dlq': { body: { jobs: [] } },
      'GET /admin/dlq/outbox': { body: { events: [] } },
      'POST /admin/credits/adjust': { body: BALANCE },
    });

    renderWithProviders(<AdminConsole />, client);

    fireEvent.change(await screen.findByLabelText('User id'), { target: { value: 'member-1' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'goodwill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ userId: 'member-1', amount: 25, reason: 'goodwill' });
    expect(await screen.findByText(/Granted 25 credits/)).toBeInTheDocument();
  });

  it('reports a reference id that was already applied instead of granting twice', async () => {
    const { client } = stubApi({
      'GET /admin/dlq': { body: { jobs: [] } },
      'GET /admin/dlq/outbox': { body: { events: [] } },
      'POST /admin/credits/adjust': {
        body: { ...BALANCE, applied: false, referenceId: 'ticket-1' },
      },
    });

    renderWithProviders(<AdminConsole />, client);

    fireEvent.change(await screen.findByLabelText('User id'), { target: { value: 'member-1' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'goodwill' } });
    fireEvent.change(screen.getByLabelText('Reference id'), { target: { value: 'ticket-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    expect(await screen.findByText(/already applied; nothing changed/)).toBeInTheDocument();
  });
});
