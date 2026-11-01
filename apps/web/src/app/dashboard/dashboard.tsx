'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo } from 'react';

import { useApi } from '../../lib/providers';
import { Icon } from '../../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LiveRegion,
  PageHeader,
  Spinner,
  StatCard,
} from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * The workspace dashboard.
 *
 * It answers four questions in the order a marketer asks them: what is my
 * balance, what is about to publish, what is performing, and what needs fixing.
 * Everything below the KPI row is composed from endpoints that already exist -
 * no dashboard-only API, no client-side aggregation that could disagree with
 * the analytics screen.
 */
export function Dashboard() {
  const api = useApi();

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.auth.me(), retry: false });
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    enabled: me.isSuccess,
  });
  const workspaceId = workspaces.data?.[0]?.id;
  const brands = useQuery({
    queryKey: ['brands', workspaceId],
    queryFn: () => (workspaceId === undefined ? Promise.resolve([]) : api.brands.list(workspaceId)),
    // Brands belong to a workspace, and the API refuses a list without one.
    // Waiting for the workspace also prevents a request that can only 400.
    enabled: workspaceId !== undefined,
  });

  // Fixed for the life of the mounted page. Recomputing "now" on every render
  // would change the query key and refetch the calendar in a loop.
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const upcoming = useQuery({
    queryKey: ['dashboard', 'upcoming', workspaceId, range.from],
    queryFn: () =>
      workspaceId === undefined ? Promise.resolve([]) : api.posts.scheduled(workspaceId, range),
    enabled: workspaceId !== undefined,
    // These are supporting widgets, not the reason the screen exists. A failure
    // here stays quiet rather than replacing the whole dashboard with an error.
    retry: false,
  });

  const overview = useQuery({
    queryKey: ['analytics', 'overview', workspaceId],
    queryFn: () => api.analytics.overview(workspaceId as string),
    enabled: workspaceId !== undefined,
    retry: false,
  });

  const accounts = useQuery({
    queryKey: ['social-accounts', workspaceId],
    queryFn: () => api.socialAccounts.list(workspaceId as string),
    enabled: workspaceId !== undefined,
    retry: false,
  });

  const notifications = useQuery({
    queryKey: ['notifications', 'dashboard'],
    queryFn: () => api.notifications.list(),
    retry: false,
  });

  if (me.isLoading) {
    return <Spinner label="Loading your workspace" />;
  }

  // Narrowed explicitly rather than trusting the query's discriminated union:
  // react-query types `data` as `T | undefined` and a component that reads it
  // without this check compiles fine and throws in a browser.
  const session = me.data;

  if (session === undefined || me.isError) {
    // Not an error box: an unauthenticated visitor needs a way in, and this is
    // the landing page for them.
    return (
      <Card title="Sign in to continue">
        <p>Your account, brands and campaigns are all behind a sign-in.</p>
        <Button
          variant="primary"
          onClick={() => {
            window.location.href = '/login';
          }}
        >
          Sign in
        </Button>
      </Card>
    );
  }

  const { wallet, user } = session;
  const firstName = user.name.split(/\s+/)[0] ?? user.name;
  const low = wallet.available < 10;
  const nextPosts = [...(upcoming.data ?? [])]
    .sort((left, right) => (left.scheduledAt ?? '').localeCompare(right.scheduledAt ?? ''))
    .slice(0, 5);
  const topCampaigns = [...(overview.data?.campaigns ?? [])]
    .sort((left, right) => right.reach - left.reach)
    .slice(0, 4);
  const maxReach = Math.max(1, ...topCampaigns.map((campaign) => campaign.reach));
  const recent = (notifications.data ?? []).slice(0, 4);
  const accountList = accounts.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Workspace overview"
        title="Dashboard"
        description={`Welcome back, ${firstName}. Here is what is publishing, what is working, and what needs a decision.`}
        actions={
          <>
            <Link href="/calendar" className={styles.button}>
              <Icon name="calendar" size={15} />
              Open calendar
            </Link>
            <Link href="/brands/new" className={`${styles.button} ${styles.primary}`}>
              <Icon name="plus" size={15} />
              New brand
            </Link>
          </>
        }
      />

      <LiveRegion message={`${wallet.available} credits available, ${wallet.reserved} reserved`} />

      <div className={styles.kpiGrid}>
        <StatCard
          label="Credits"
          value={wallet.available}
          hint="available to spend"
          icon={<Icon name="credits" />}
          tone={low ? 'warning' : 'accent'}
          badge={low ? <Badge tone="warn">Running low</Badge> : undefined}
        />
        <StatCard
          label="Reserved"
          value={wallet.reserved}
          hint="held by running work"
          icon={<Icon name="clock" />}
          tone="info"
        />
        <StatCard
          label="Upcoming posts"
          value={upcoming.data === undefined ? '—' : upcoming.data.length}
          hint="next 14 days"
          icon={<Icon name="calendar" />}
          tone="success"
        />
        <StatCard
          label="Reach"
          value={overview.data === undefined ? '—' : overview.data.totals.reach.toLocaleString()}
          hint="latest synced snapshot"
          icon={<Icon name="trend" />}
          tone="info"
        />
      </div>

      <section className={styles.heroPanel} aria-labelledby="dashboard-hero-title">
        <div>
          <p className={styles.pageEyebrow}>From brief to calendar</p>
          <h2 id="dashboard-hero-title" className={styles.heroTitle}>
            Turn the next idea into{' '}
            <span className={styles.heroTitleAccent}>a week of content.</span>
          </h2>
          <p className={styles.heroText}>
            Start with a brand voice, plan a campaign, and let RenderFlow draft the captions,
            posters and reels. Review them together, then schedule only what is ready.
          </p>
          <div className={styles.heroActions}>
            <Link href="/brands" className={`${styles.button} ${styles.primary}`}>
              <Icon name="sparkles" size={15} />
              Start a campaign
            </Link>
            <Link href="/analytics" className={styles.button}>
              <Icon name="analytics" size={15} />
              See performance
            </Link>
          </div>
        </div>

        <div className={styles.heroVisual} aria-hidden="true">
          <div className={styles.previewStack}>
            <div className={`${styles.previewCard} ${styles.previewCardBack}`}>
              <div className={styles.previewThumb} />
              <div className={styles.previewLine} />
              <div className={`${styles.previewLine} ${styles.previewLineShort}`} />
            </div>
            <div className={`${styles.previewCard} ${styles.previewCardMiddle}`}>
              <div className={styles.previewThumb} />
              <div className={styles.previewLine} />
              <div className={`${styles.previewLine} ${styles.previewLineShort}`} />
            </div>
            <div className={`${styles.previewCard} ${styles.previewCardFront}`}>
              <div className={styles.previewThumb} />
              <div className={styles.previewLine} />
              <div className={`${styles.previewLine} ${styles.previewLineShort}`} />
            </div>
          </div>
        </div>
      </section>

      <div className={styles.dashboardGrid}>
        <div className={styles.dashboardColumn}>
          <Card
            title="Upcoming posts"
            description="Everything scheduled for the next two weeks, in publishing order."
            actions={
              <Link href="/calendar" className={styles.minorLink}>
                View calendar
                <Icon name="arrowUpRight" size={13} />
              </Link>
            }
          >
            {upcoming.isLoading && <Spinner label="Loading your schedule" />}

            {upcoming.isError && (
              <p className={styles.cardDescription}>
                The schedule could not be loaded right now. Open the calendar to try again.
              </p>
            )}

            {upcoming.data !== undefined && upcoming.data.length === 0 && (
              <EmptyState
                icon={<Icon name="calendar" size={18} />}
                title="Nothing scheduled yet"
                description="Approve a post and choose a publishing time and it will appear here."
                action={
                  <Link href="/calendar" className={styles.button}>
                    Open the calendar
                  </Link>
                }
              />
            )}

            {nextPosts.length > 0 && (
              <ul className={styles.upcomingList}>
                {nextPosts.map((post) => {
                  const at = post.scheduledAt === null ? null : new Date(post.scheduledAt);

                  return (
                    <li key={post.id} className={styles.upcomingItem}>
                      <span className={styles.upcomingDate}>
                        <span className={styles.upcomingDay}>{at?.getDate() ?? '—'}</span>
                        <span className={styles.upcomingMonth}>
                          {at?.toLocaleDateString(undefined, { month: 'short' }) ?? ''}
                        </span>
                      </span>
                      <span className={styles.upcomingCopy}>
                        <span className={styles.upcomingTitle}>{post.campaignGoal}</span>
                        <span className={styles.upcomingMeta}>
                          <span className={styles.typeChip}>{post.type}</span>
                          <span>{post.brandName}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {at?.toLocaleTimeString(undefined, {
                              hour: '2-digit',
                              minute: '2-digit',
                            }) ?? 'Unscheduled'}
                          </span>
                        </span>
                      </span>
                      <Link
                        href="/calendar"
                        className={styles.upcomingAction}
                        aria-label={`Open ${post.type} post in the calendar`}
                      >
                        <Icon name="chevronRight" size={16} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            title="Brands"
            description="A brand carries the voice every post is written in."
            actions={
              <Link href="/brands" className={styles.minorLink}>
                View all
                <Icon name="arrowUpRight" size={13} />
              </Link>
            }
          >
            {brands.isLoading && <Spinner label="Loading brands" />}

            {brands.isError && (
              <ErrorNotice
                message="Could not load your brands."
                onRetry={() => void brands.refetch()}
              />
            )}

            {brands.data !== undefined && brands.data.length === 0 && (
              <EmptyState
                icon={<Icon name="brands" size={18} />}
                title="No brands yet"
                description="Create a brand and the planner will write posts in its voice."
                action={
                  <Link href="/brands/new" className={`${styles.button} ${styles.primary}`}>
                    Create your first brand
                  </Link>
                }
              />
            )}

            {brands.data !== undefined && brands.data.length > 0 && (
              <div className={styles.brandGrid}>
                {brands.data.map((brand) => (
                  <article key={brand.id} className={styles.brandCard}>
                    <div className={styles.brandCardHead}>
                      <span className={styles.brandAvatar} aria-hidden="true">
                        {initialsOf(brand.name)}
                      </span>
                      <span>
                        <Link href={`/brands/${brand.id}`} className={styles.brandName}>
                          {brand.name}
                        </Link>
                        <span className={styles.brandIndustry}>
                          {brand.industry ?? 'No industry set'}
                        </span>
                      </span>
                    </div>

                    <div className={styles.brandTags}>
                      {brand.languages.slice(0, 3).map((language) => (
                        <span key={language} className={styles.tag}>
                          {language.toUpperCase()}
                        </span>
                      ))}
                      {brand.colors.slice(0, 3).map((color) => (
                        <span key={color} className={styles.tag}>
                          {color}
                        </span>
                      ))}
                    </div>

                    <div className={styles.brandFooter}>
                      <span>Brand voice</span>
                      <Link
                        href={`/brands/${brand.id}`}
                        className={styles.minorLink}
                        aria-label={`Open ${brand.name}`}
                      >
                        Open
                        <Icon name="arrowUpRight" size={12} />
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Campaign performance"
            description="Reach from the latest synced snapshot, ranked across the workspace."
            actions={
              <Link href="/analytics" className={styles.minorLink}>
                Full report
                <Icon name="arrowUpRight" size={13} />
              </Link>
            }
          >
            {topCampaigns.length === 0 ? (
              <EmptyState
                icon={<Icon name="analytics" size={18} />}
                title="No performance yet"
                description="Analytics starts once a campaign has published a post and the sync has run."
                action={
                  <Link href="/analytics" className={styles.button}>
                    Open analytics
                  </Link>
                }
              />
            ) : (
              <div className={styles.barChart}>
                {topCampaigns.map((campaign) => (
                  <div key={campaign.id}>
                    <div className={styles.barMeta}>
                      <Link href={`/campaigns/${campaign.id}`} className={styles.barLabel}>
                        {campaign.goal}
                      </Link>
                      <span className={styles.barValue}>
                        {campaign.reach.toLocaleString()} reach
                      </span>
                    </div>
                    <div className={styles.barTrack} aria-hidden="true">
                      <span
                        className={styles.barFill}
                        style={{ width: `${Math.round((campaign.reach / maxReach) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className={styles.dashboardColumn}>
          <Card title="Quick actions" description="The four things teams do most.">
            <div className={styles.quickActions}>
              <Link href="/brands/new" className={styles.quickAction}>
                <Icon name="plus" size={17} className={styles.quickActionIcon} />
                New brand
              </Link>
              <Link href="/brands" className={styles.quickAction}>
                <Icon name="sparkles" size={17} className={styles.quickActionIcon} />
                Plan a campaign
              </Link>
              <Link href="/calendar" className={styles.quickAction}>
                <Icon name="calendar" size={17} className={styles.quickActionIcon} />
                Schedule a post
              </Link>
              <Link href="/settings/accounts" className={styles.quickAction}>
                <Icon name="accounts" size={17} className={styles.quickActionIcon} />
                Connect a channel
              </Link>
            </div>
          </Card>

          <Card
            title="Connected accounts"
            description="Where approved posts can publish."
            actions={
              <Link href="/settings/accounts" className={styles.minorLink}>
                Manage
              </Link>
            }
          >
            {accounts.isLoading && <Spinner label="Loading accounts" />}

            {accounts.data !== undefined && accountList.length === 0 && (
              <p className={styles.cardDescription}>
                No channels connected yet. Connect LinkedIn or Instagram before scheduling a post.
              </p>
            )}

            {accountList.length > 0 && (
              <ul className={styles.healthList}>
                {accountList.map((account) => (
                  <li key={account.id} className={styles.healthItem}>
                    <span
                      className={styles.healthIcon}
                      data-platform={account.platform}
                      aria-hidden="true"
                    >
                      {account.platform.slice(0, 2).toUpperCase()}
                    </span>
                    <span className={styles.healthCopy}>
                      <span className={styles.healthName}>
                        {account.displayName ?? account.platform}
                      </span>
                      <span className={styles.healthMeta}>
                        {account.platform} · {account.externalAccountId}
                      </span>
                    </span>
                    <span
                      className={
                        account.needsReconnect
                          ? `${styles.statusDot} ${styles.statusDotWarn}`
                          : styles.statusDot
                      }
                      aria-label={account.needsReconnect ? 'Reconnect needed' : 'Connected'}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Recent activity"
            description="Publish results and credit movements."
            actions={
              <Link href="/notifications" className={styles.minorLink}>
                View all
              </Link>
            }
          >
            {notifications.isLoading && <Spinner label="Loading activity" />}

            {notifications.data !== undefined && recent.length === 0 && (
              <p className={styles.cardDescription}>Nothing has happened yet.</p>
            )}

            {recent.length > 0 && (
              <ul className={styles.miniList}>
                {recent.map((notification) => (
                  <li key={notification.id} className={styles.miniItem}>
                    <span className={styles.miniDot} aria-hidden="true" />
                    <span className={styles.miniCopy}>
                      <span className={styles.miniTitle}>{notification.title}</span>
                      <span className={styles.miniMeta}>
                        {relativeTime(notification.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function initialsOf(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? 'B';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();

  if (!Number.isFinite(then)) {
    return '';
  }

  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) {
    return 'Just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  return days === 1 ? 'Yesterday' : `${days}d ago`;
}
