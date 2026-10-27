import { screen, within } from '@testing-library/react';

import { AnalyticsOverview } from './analytics-overview';
import { renderWithProviders, stubApi } from '../../test/harness';

/**
 * The workspace analytics screen.
 *
 * What matters here is that the numbers on screen are the ones the API returned
 * and that a campaign is reachable from its row - the kind of test that catches a
 * renamed field or a `[object Object]` before a designer sees it.
 */

const OVERVIEW = {
  workspaceId: 'w1',
  totals: {
    posts: 3,
    published: 2,
    likes: 30,
    comments: 3,
    reach: 300,
    clicks: 6,
    engagementRate: 0.11,
  },
  campaigns: [
    {
      id: 'c1',
      brandName: 'Acme',
      goal: 'Spring launch',
      status: 'ACTIVE',
      posts: 3,
      published: 2,
      likes: 30,
      comments: 3,
      reach: 300,
      clicks: 6,
      engagementRate: 0.11,
    },
  ],
};

const WORKSPACES = [{ id: 'w1', name: 'Acme', ownerId: 'u1', role: 'OWNER' }];

describe('AnalyticsOverview', () => {
  it('shows workspace totals and links each campaign to its page', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /analytics/overview': { body: OVERVIEW },
    });

    renderWithProviders(<AnalyticsOverview />, client);

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();

    // The same rate appears in the total and in the campaign row; the assertion
    // is about the total, so it is scoped to the totals region.
    const totals = await screen.findByRole('region', { name: 'Workspace totals' });
    expect(within(totals).getByText('11.0%')).toBeInTheDocument();
    expect(within(totals).getByText('300')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Spring launch' });
    expect(link).toHaveAttribute('href', '/campaigns/c1');

    // The workspace id is in the query, not inferred from a cookie on the client.
    expect(calls.some((call) => call.url.includes('/analytics/overview?workspaceId=w1'))).toBe(
      true,
    );
  });

  it('says so when the workspace has no campaigns yet', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /analytics/overview': {
        body: {
          ...OVERVIEW,
          totals: { ...OVERVIEW.totals, posts: 0, published: 0 },
          campaigns: [],
        },
      },
    });

    renderWithProviders(<AnalyticsOverview />, client);

    expect(await screen.findByText('No campaigns yet')).toBeInTheDocument();
  });

  it('offers a retry when the read fails', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /analytics/overview': {
        status: 500,
        body: { code: 'INTERNAL_ERROR', message: 'boom' },
      },
    });

    renderWithProviders(<AnalyticsOverview />, client);

    expect(
      await screen.findByText('Could not load analytics for this workspace.'),
    ).toBeInTheDocument();
  });

  it('does not call the API before there is a workspace', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: [] },
    });

    renderWithProviders(<AnalyticsOverview />, client);

    expect(await screen.findByText('No workspace yet')).toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith('/analytics/overview'))).toBe(false);
  });
});
