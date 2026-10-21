'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { useApi } from '../../lib/providers';
import { Card, EmptyState, ErrorNotice, Spinner } from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * Workspace analytics (PROJECT.md Phase 9).
 *
 * One request for every campaign: the numbers come from already-synchronised
 * snapshots, so the page is a read of `post_metrics`, never a platform call.
 * A user opening this page cannot accidentally trigger a sync or spend a credit.
 */
export function AnalyticsOverview() {
  const api = useApi();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
  });

  // The product is single-workspace for the people who use it today; the first
  // workspace is the same one every other screen acts on. A workspace switcher
  // belongs with the workspace list, not duplicated here.
  const workspaceId = workspaces.data?.[0]?.id;

  const overview = useQuery({
    queryKey: ['analytics', 'overview', workspaceId],
    queryFn: () => api.analytics.overview(workspaceId as string),
    enabled: workspaceId !== undefined,
  });

  if (workspaces.isLoading) {
    return <Spinner label="Loading your workspace" />;
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
        description="Create a brand first; a workspace is created with it."
        action={
          <Link href="/brands/new">
            <button type="button" className={styles.button}>
              Create a brand
            </button>
          </Link>
        }
      />
    );
  }

  return (
    <>
      <h1>Analytics</h1>
      <p className={styles.cardDescription}>
        Engagement is pulled from each connected platform after a post goes live. The numbers here
        are the latest snapshot per publication, not a live call.
      </p>

      {overview.isLoading && <Spinner label="Loading analytics" />}

      {overview.isError && (
        <ErrorNotice
          message="Could not load analytics for this workspace."
          onRetry={() => void overview.refetch()}
        />
      )}

      {overview.data !== undefined && (
        <>
          <section className={styles.statGrid} aria-label="Workspace totals">
            <Stat label="Reach" value={overview.data.totals.reach} />
            <Stat label="Likes" value={overview.data.totals.likes} />
            <Stat label="Comments" value={overview.data.totals.comments} />
            <Stat label="Clicks" value={overview.data.totals.clicks} />
            <Stat
              label="Engagement rate"
              value={`${(overview.data.totals.engagementRate * 100).toFixed(1)}%`}
            />
            <Stat
              label="Published"
              value={`${overview.data.totals.published}/${overview.data.totals.posts}`}
            />
          </section>

          <Card
            title="Campaigns"
            description="Open a campaign to see its daily series and what to post next."
          >
            {overview.data.campaigns.length === 0 ? (
              <EmptyState
                title="No campaigns yet"
                description="Analytics starts once a campaign has published a post."
              />
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Campaign</th>
                      <th scope="col">Brand</th>
                      <th scope="col">Status</th>
                      <th scope="col" className={styles.numeric}>
                        Published
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Reach
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Likes
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Engagement
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.campaigns.map((campaign) => (
                      <tr key={campaign.id}>
                        <td>
                          <Link href={`/campaigns/${campaign.id}`}>{campaign.goal}</Link>
                        </td>
                        <td>{campaign.brandName}</td>
                        <td>{campaign.status}</td>
                        <td className={styles.numeric}>
                          {campaign.published}/{campaign.posts}
                        </td>
                        <td className={styles.numeric}>{campaign.reach}</td>
                        <td className={styles.numeric}>{campaign.likes}</td>
                        <td className={styles.numeric}>
                          {(campaign.engagementRate * 100).toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.stat}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
