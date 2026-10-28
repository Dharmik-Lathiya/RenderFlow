'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { useApi } from '../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LiveRegion,
  Spinner,
} from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * The dashboard: credits, brands, and where to go next.
 *
 * The credit balance is at the top because it gates everything else. A user who
 * is about to run out should find out before they compose a reel, not after -
 * which is why it is the first thing on the page and not in the nav.
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
        <Link href="/login">
          <Button variant="primary">Sign in</Button>
        </Link>
      </Card>
    );
  }

  const { wallet } = session;

  return (
    <>
      <h1>Dashboard</h1>

      <LiveRegion message={`${wallet.available} credits available, ${wallet.reserved} reserved`} />

      <Card
        title="Credits"
        description="Reserved credits are held by work that is running right now."
        actions={wallet.available < 10 ? <Badge tone="warn">Running low</Badge> : undefined}
      >
        <div className={styles.row}>
          <strong className={styles.balance}>{wallet.available}</strong>
          <span>available</span>
          <span aria-hidden="true">·</span>
          <strong className={styles.balance}>{wallet.reserved}</strong>
          <span>reserved</span>
        </div>

        {wallet.available === 0 && wallet.reserved === 0 && (
          <div className={styles.errorNotice} role="status">
            <p>
              You have no credits left. Nothing is charged until work completes, so a failed job
              costs you nothing - but a new one needs a balance.
            </p>
            {/* The pricing page, not the brands list: a user with no credits
                needs to know what credits cost, and sending them to a page of
                brands they cannot generate for is a dead end. */}
            <Link href="/pricing">
              <Button variant="primary">See plans</Button>
            </Link>
          </div>
        )}
      </Card>

      <Card
        title="Brands"
        description="A brand carries the voice every post is written in."
        actions={
          <Link href="/brands/new">
            <Button variant="primary">New brand</Button>
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
            title="No brands yet"
            description="Create a brand and the planner will write posts in its voice."
            action={
              <Link href="/brands/new">
                <Button variant="primary">Create your first brand</Button>
              </Link>
            }
          />
        )}

        {brands.data !== undefined && brands.data.length > 0 && (
          <ul className={styles.list}>
            {brands.data.map((brand) => (
              <li key={brand.id} className={styles.listItem}>
                <span>
                  <Link href={`/brands/${brand.id}`}>{brand.name}</Link>
                  {brand.industry !== null && (
                    <span className={styles.cardDescription}> · {brand.industry}</span>
                  )}
                </span>
                <Link href={`/brands/${brand.id}`}>Open</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
