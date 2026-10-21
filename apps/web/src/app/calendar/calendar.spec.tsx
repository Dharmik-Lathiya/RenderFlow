import { fireEvent, screen, waitFor } from '@testing-library/react';

import { Calendar } from './calendar';
import { renderWithProviders, stubApi } from '../../test/harness';
import type { StubRequest } from '../../test/harness';

/**
 * The content calendar.
 *
 * The drag interaction itself cannot be exercised faithfully in jsdom, so these
 * tests cover the path that drag and the keyboard both take: `moveTo` builds the
 * new instant from the target day and the post's existing time, then PATCHes.
 * That is the logic where a timezone mistake would show up as a post silently
 * jumping an hour.
 */

const NOW = new Date();

function postOn(day: number, hour: number, minute: number) {
  return new Date(NOW.getFullYear(), NOW.getMonth(), day, hour, minute, 0);
}

const SCHEDULED = [
  {
    id: 'p1',
    campaignId: 'c1',
    brandId: 'b1',
    type: 'REEL',
    caption: 'A reel',
    status: 'APPROVED',
    scheduledAt: postOn(15, 10, 30).toISOString(),
    version: 1,
    campaignGoal: 'Spring launch',
    brandName: 'Acme',
  },
];

const WORKSPACES = [{ id: 'w1', name: 'Acme', ownerId: 'u1' }];

describe('Calendar', () => {
  it('shows each scheduled post on its day with its time and brand', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /posts': { body: SCHEDULED },
    });

    renderWithProviders(<Calendar />, client);

    expect(await screen.findByText('REEL')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(/10:30/)).toBeInTheDocument();
  });

  it('moves a post to another day, keeping its time of day', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /posts': { body: SCHEDULED },
      'PATCH /posts/{postId}/schedule': (request: StubRequest) => ({
        body: {
          postId: 'p1',
          scheduledAt: (request.body as { scheduledAt: string }).scheduledAt,
          updated: 1,
        },
      }),
    });

    renderWithProviders(<Calendar />, client);

    const input = await screen.findByLabelText('Move REEL post to another day');
    const month = `${NOW.getMonth() + 1}`.padStart(2, '0');
    fireEvent.change(input, {
      target: { value: `${NOW.getFullYear()}-${month}-16` },
    });

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
    });

    const patch = calls.find((call) => call.method === 'PATCH');
    const sent = new Date((patch?.body as { scheduledAt: string }).scheduledAt);

    expect(sent.getFullYear()).toBe(NOW.getFullYear());
    expect(sent.getMonth()).toBe(NOW.getMonth());
    expect(sent.getDate()).toBe(16);
    // 10:30 on the old day is 10:30 on the new one. The calendar moves days, not
    // instants, and a user dragging a post expects the hour to stay put.
    expect(sent.getHours()).toBe(10);
    expect(sent.getMinutes()).toBe(30);
  });

  it('cancels only after confirmation', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /posts': { body: SCHEDULED },
      'DELETE /posts/{postId}/schedule': { body: { cancelled: 1 } },
    });

    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<Calendar />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(confirm).toHaveBeenCalled();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  it('navigates months without losing the grid', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /posts': { body: SCHEDULED },
    });

    renderWithProviders(<Calendar />, client);

    const next = await screen.findByRole('button', { name: 'Next month' });
    fireEvent.click(next);

    const expected = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).toLocaleDateString(
      undefined,
      { month: 'long', year: 'numeric' },
    );
    expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument();
  });
});
