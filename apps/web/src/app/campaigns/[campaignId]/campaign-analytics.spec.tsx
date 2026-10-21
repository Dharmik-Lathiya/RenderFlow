import { screen } from '@testing-library/react';

import { CampaignAnalytics } from './campaign-analytics';
import { renderWithProviders, stubApi } from '../../../test/harness';

/**
 * One campaign's analytics panel.
 *
 * The totals, the daily series and the suggestions are three different reads of
 * the same snapshots. These tests pin the distinction a user would notice: the
 * latest snapshot is the headline, the series is one point per day, and a
 * publication with no snapshot says so instead of showing zeroes.
 */

const ANALYTICS = {
  campaign: {
    id: 'c1',
    brandId: 'b1',
    goal: 'Spring launch',
    status: 'ACTIVE',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  },
  totals: {
    posts: 2,
    published: 1,
    likes: 30,
    comments: 3,
    reach: 300,
    clicks: 6,
    engagementRate: 0.11,
  },
  publications: [
    {
      postId: 'p1',
      type: 'REEL',
      status: 'PUBLISHED',
      caption: 'A reel',
      scheduledAt: '2026-06-10T09:00:00.000Z',
      publishJobId: 'j1',
      publishStatus: 'PUBLISHED',
      platform: 'instagram',
      externalUrl: 'https://example.com/reel-1',
      publishedAt: '2026-06-10T09:00:00.000Z',
      metrics: {
        likes: 30,
        comments: 3,
        reach: 300,
        clicks: 6,
        fetchedAt: '2026-06-11T10:00:00.000Z',
      },
    },
    {
      postId: 'p2',
      type: 'CAPTION',
      status: 'APPROVED',
      caption: 'Caption one',
      scheduledAt: null,
      publishJobId: null,
      publishStatus: null,
      platform: null,
      externalUrl: null,
      publishedAt: null,
      metrics: null,
    },
  ],
  series: [
    { date: '2026-06-10', likes: 20, comments: 2, reach: 200, clicks: 4 },
    { date: '2026-06-11', likes: 30, comments: 3, reach: 300, clicks: 6 },
  ],
  suggestions: [
    {
      type: 'REEL',
      title: 'Make another reel',
      rationale: "reel is this campaign's strongest format: 11.0% engagement.",
    },
    {
      type: 'POSTER',
      title: 'Try a poster',
      rationale: 'No poster has been published in this campaign yet.',
    },
  ],
};

describe('CampaignAnalytics', () => {
  it('renders the latest totals, the daily series and the suggestions', async () => {
    const { client } = stubApi({
      'GET /analytics/campaigns/{campaignId}': { body: ANALYTICS },
    });

    renderWithProviders(<CampaignAnalytics campaignId="c1" />, client);

    expect(await screen.findByText('Performance')).toBeInTheDocument();
    expect(screen.getByText('11.0%')).toBeInTheDocument();

    // One row per day, with the day's latest snapshot - not a sum of snapshots.
    expect(screen.getByText('2026-06-10')).toBeInTheDocument();
    expect(screen.getByText('2026-06-11')).toBeInTheDocument();

    expect(screen.getByText('Make another reel')).toBeInTheDocument();
    expect(screen.getByText(/strongest format/)).toBeInTheDocument();

    const view = screen.getByRole('link', { name: 'View' });
    expect(view).toHaveAttribute('href', 'https://example.com/reel-1');
  });

  it('shows a dash for a post with no metrics, not a row of zeroes', async () => {
    const { client } = stubApi({
      'GET /analytics/campaigns/{campaignId}': { body: ANALYTICS },
    });

    renderWithProviders(<CampaignAnalytics campaignId="c1" />, client);

    await screen.findByText('Publications');

    // The caption publication has metrics: null; its reach cell is an em dash.
    const rows = screen.getAllByRole('row');
    const caption = rows.find((row) => row.textContent?.includes('CAPTION'));
    expect(caption).toBeDefined();
    expect(caption?.textContent).toContain('—');
  });

  it('explains an empty series rather than drawing a blank chart', async () => {
    const { client } = stubApi({
      'GET /analytics/campaigns/{campaignId}': {
        body: { ...ANALYTICS, series: [], suggestions: [] },
      },
    });

    renderWithProviders(<CampaignAnalytics campaignId="c1" />, client);

    expect(await screen.findByText('No metrics yet')).toBeInTheDocument();
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
  });
});
