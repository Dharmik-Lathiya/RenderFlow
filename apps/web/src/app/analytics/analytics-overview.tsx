'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { useApi } from '../../lib/providers';
import { Icon } from '../../components/icons';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  StatCard,
} from '../../components/ui';
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
          <Link href="/brands/new" className={`${styles.button} ${styles.primary}`}>
            Create a brand
          </Link>
        }
      />
    );
  }

  const totals = overview.data?.totals;
  const campaigns = overview.data?.campaigns ?? [];
  const bestCampaign = [...campaigns].sort((left, right) => right.reach - left.reach)[0];
  const maxReach = Math.max(1, ...campaigns.map((campaign) => campaign.reach));

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description="Engagement is pulled from each connected platform after a post goes live. The numbers here are the latest snapshot per publication, not a live call."
        actions={
          <>
            <Link href="/calendar" className={styles.button}>
              <Icon name="calendar" size={15} />
              Open calendar
            </Link>
            <Link href="/brands" className={`${styles.button} ${styles.primary}`}>
              <Icon name="sparkles" size={15} />
              Plan a campaign
            </Link>
          </>
        }
      />

      {overview.isLoading && <Spinner label="Loading analytics" />}

      {overview.isError && (
        <ErrorNotice
          message="Could not load analytics for this workspace."
          onRetry={() => void overview.refetch()}
        />
      )}

      {overview.data !== undefined && (
        <>
          <section className={styles.kpiGrid} aria-label="Workspace totals">
            <StatCard
              label="Reach"
              value={totals?.reach.toLocaleString() ?? '0'}
              hint="people reached"
              icon={<Icon name="eye" />}
            />
            <StatCard
              label="Engagement rate"
              value={`${((totals?.engagementRate ?? 0) * 100).toFixed(1)}%`}
              hint="across published posts"
              icon={<Icon name="heart" />}
              tone="success"
            />
            <StatCard
              label="Likes"
              value={totals?.likes.toLocaleString() ?? '0'}
              hint="latest snapshots"
              icon={<Icon name="heart" />}
              tone="success"
            />
            <StatCard
              label="Comments"
              value={totals?.comments.toLocaleString() ?? '0'}
              hint="conversation volume"
              icon={<Icon name="message" />}
              tone="info"
            />
            <StatCard
              label="Clicks"
              value={totals?.clicks.toLocaleString() ?? '0'}
              hint="link clicks"
              icon={<Icon name="click" />}
              tone="warning"
            />
            <StatCard
              label="Published"
              value={`${totals?.published ?? 0}/${totals?.posts ?? 0}`}
              hint="posts live"
              icon={<Icon name="check" />}
            />
          </section>

          <div className={styles.dashboardGrid}>
            <div className={styles.dashboardColumn}>
              <Card
                title="Campaigns"
                description="Open a campaign to see its daily series and what to post next."
                actions={
                  <span className={styles.cardDescription}>
                    {campaigns.length} {campaigns.length === 1 ? 'campaign' : 'campaigns'}
                  </span>
                }
              >
                {campaigns.length === 0 ? (
                  <EmptyState
                    icon={<Icon name="analytics" size={18} />}
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
                        {campaigns.map((campaign) => (
                          <tr key={campaign.id}>
                            <td>
                              <Link href={`/campaigns/${campaign.id}`}>{campaign.goal}</Link>
                            </td>
                            <td>{campaign.brandName}</td>
                            <td>
                              <Badge tone={campaign.status === 'ACTIVE' ? 'good' : 'neutral'}>
                                {campaign.status}
                              </Badge>
                            </td>
                            <td className={styles.numeric}>
                              {campaign.published}/{campaign.posts}
                            </td>
                            <td className={styles.numeric}>{campaign.reach.toLocaleString()}</td>
                            <td className={styles.numeric}>{campaign.likes.toLocaleString()}</td>
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

              {campaigns.length > 0 && (
                <Card
                  title="Reach by campaign"
                  description="The same totals as the table, sized so the gap between campaigns is visible."
                >
                  <div className={styles.barChart}>
                    {campaigns.map((campaign) => (
                      <div key={campaign.id}>
                        <div className={styles.barMeta}>
                          <span className={styles.barLabel}>{campaign.goal}</span>
                          <span className={styles.barValue}>{campaign.reach.toLocaleString()}</span>
                        </div>
                        <div className={styles.barTrack} aria-hidden="true">
                          <span
                            className={styles.barFill}
                            style={{
                              width: `${Math.round((campaign.reach / maxReach) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            <div className={styles.dashboardColumn}>
              <Card title="Snapshot" description="What these numbers represent.">
                <div className={styles.summaryStack}>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Best campaign</span>
                    <span className={styles.summaryValue} style={{ fontSize: '0.82rem' }}>
                      {bestCampaign?.goal ?? '—'}
                    </span>
                  </div>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Top reach</span>
                    <span className={styles.summaryValue}>
                      {bestCampaign?.reach.toLocaleString() ?? '0'}
                    </span>
                  </div>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Avg. engagement</span>
                    <span className={styles.summaryValue}>
                      {((totals?.engagementRate ?? 0) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Posts live</span>
                    <span className={styles.summaryValue}>
                      {totals?.published ?? 0}/{totals?.posts ?? 0}
                    </span>
                  </div>
                </div>
              </Card>

              <Card
                title="How it updates"
                description="No manual refresh, no platform call on page load."
              >
                <ul className={styles.miniList}>
                  <li className={styles.miniItem}>
                    <span className={styles.miniDot} aria-hidden="true" />
                    <span className={styles.miniCopy}>
                      <span className={styles.miniTitle}>
                        The analytics worker syncs published posts
                      </span>
                      <span className={styles.miniMeta}>
                        The first snapshot runs a few minutes after publishing.
                      </span>
                    </span>
                  </li>
                  <li className={styles.miniItem}>
                    <span className={styles.miniDot} aria-hidden="true" />
                    <span className={styles.miniCopy}>
                      <span className={styles.miniTitle}>
                        Each publication keeps its latest snapshot
                      </span>
                      <span className={styles.miniMeta}>
                        Refreshing the page cannot double-count a post.
                      </span>
                    </span>
                  </li>
                  <li className={styles.miniItem}>
                    <span className={styles.miniDot} aria-hidden="true" />
                    <span className={styles.miniCopy}>
                      <span className={styles.miniTitle}>Nothing here spends credits</span>
                      <span className={styles.miniMeta}>
                        Analytics is a read of stored metrics, not a generation.
                      </span>
                    </span>
                  </li>
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
