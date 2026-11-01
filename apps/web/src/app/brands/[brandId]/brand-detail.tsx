'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import { Icon } from '../../../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  PageHeader,
  Spinner,
} from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * A brand, its campaigns, and the posts inside them.
 *
 * The campaign form is inline rather than a separate wizard page because the goal
 * is one field and the plan it produces is the point - a modal would hide the
 * result the user is waiting for.
 */
export function BrandDetail({ brandId }: { brandId: string }) {
  const api = useApi();
  const client = useQueryClient();

  const brand = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => api.brands.detail(brandId),
  });
  const campaigns = useQuery({
    queryKey: ['campaigns', brandId],
    queryFn: () => api.brands.campaigns(brandId),
    enabled: brand.isSuccess,
  });

  const [goal, setGoal] = useState('');
  const [touched, setTouched] = useState(false);

  const goalError =
    touched && goal.trim().length < 3 ? 'Describe the goal in a sentence.' : undefined;

  const create = useMutation({
    mutationFn: () => api.campaigns.create({ brandId, goal: goal.trim() }),
    // Never retried automatically: a retry here creates a SECOND campaign, and
    // the user would see two identical ones and no way to tell which is real.
    retry: false,
    onSuccess: async () => {
      setGoal('');
      setTouched(false);
      await client.invalidateQueries({ queryKey: ['campaigns', brandId] });
    },
  });

  if (brand.isLoading) {
    return <Spinner label="Loading brand" />;
  }

  if (brand.isError || brand.data === undefined) {
    return (
      <ErrorNotice message="Could not load that brand." onRetry={() => void brand.refetch()} />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Brand"
        title={brand.data.name}
        description={
          brand.data.industry === null
            ? 'The voice, palette and campaigns for this brand.'
            : `${brand.data.industry} · the voice, palette and campaigns for this brand.`
        }
        meta={
          <>
            <span className={styles.tag}>{brand.data.languages.join(', ').toUpperCase()}</span>
            {brand.data.tone !== null && brand.data.tone !== undefined && (
              <span className={styles.tag}>Tone: {brand.data.tone}</span>
            )}
            <span className={styles.tag}>{campaigns.data?.length ?? 0} campaigns</span>
          </>
        }
        actions={
          <>
            <Link href="/brands" className={styles.button}>
              <Icon name="chevronLeft" size={15} />
              All brands
            </Link>
            <a href="#new-campaign" className={`${styles.button} ${styles.primary}`}>
              <Icon name="plus" size={15} />
              New campaign
            </a>
          </>
        }
      />

      <div className={styles.dashboardGrid}>
        <div className={styles.dashboardColumn}>
          <Card
            title="Campaigns"
            description="Each campaign keeps its own goal, posts and performance."
            actions={
              <span className={styles.cardDescription}>
                {campaigns.data?.length ?? 0}{' '}
                {campaigns.data?.length === 1 ? 'campaign' : 'campaigns'}
              </span>
            }
          >
            {campaigns.isLoading && <Spinner label="Loading campaigns" />}

            {campaigns.isError && (
              <ErrorNotice
                message="Could not load campaigns."
                onRetry={() => void campaigns.refetch()}
              />
            )}

            {campaigns.data !== undefined && campaigns.data.length === 0 && (
              <EmptyState
                icon={<Icon name="sparkles" size={18} />}
                title="No campaigns yet"
                description="Describe a goal in the form and the planner will draft posts for it."
              />
            )}

            {campaigns.data !== undefined && campaigns.data.length > 0 && (
              <ul className={styles.list}>
                {campaigns.data.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaignId={campaign.id}
                    goal={campaign.goal}
                    status={campaign.status}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className={styles.dashboardColumn}>
          <Card
            title="New campaign"
            description="Describe what you want to achieve. The planner drafts posts for it."
          >
            <form
              id="new-campaign"
              onSubmit={(event) => {
                event.preventDefault();
                setTouched(true);

                if (goal.trim().length < 3) {
                  return;
                }

                create.mutate();
              }}
              noValidate
            >
              {create.isError && (
                <ErrorNotice
                  message={
                    create.error instanceof ApiClientError && create.error.isInsufficientCredits
                      ? 'Not enough credits to plan a campaign. Nothing was charged.'
                      : 'Could not create the campaign.'
                  }
                />
              )}

              <Field
                label="Goal"
                id="campaign-goal"
                error={goalError}
                hint="For example: announce our spring collection to existing customers."
              >
                {({ id, describedBy, invalid }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                    onBlur={() => setTouched(true)}
                  />
                )}
              </Field>

              <Button type="submit" variant="primary" busy={create.isPending}>
                Plan campaign
              </Button>
            </form>
          </Card>

          <Card title="Brand voice" description="What the planner reads before it writes.">
            <div className={styles.summaryStack}>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Tone</span>
                <span className={styles.summaryValue} style={{ fontSize: '0.82rem' }}>
                  {brand.data.tone ?? 'Not set'}
                </span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Audience</span>
                <span className={styles.summaryValue} style={{ fontSize: '0.82rem' }}>
                  {brand.data.audience ?? 'Not set'}
                </span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Languages</span>
                <span className={styles.summaryValue} style={{ fontSize: '0.82rem' }}>
                  {brand.data.languages.join(', ') || 'None set'}
                </span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Palette</span>
                <span className={styles.summaryValue} style={{ fontSize: '0.82rem' }}>
                  {brand.data.colors.length === 0 ? 'No colours set' : brand.data.colors.join(', ')}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function CampaignRow({
  campaignId,
  goal,
  status,
}: {
  campaignId: string;
  goal: string;
  status: string;
}) {
  const api = useApi();

  const posts = useQuery({
    queryKey: ['posts', campaignId],
    queryFn: () => api.campaigns.posts(campaignId),
  });

  return (
    <li className={styles.listItem}>
      <span>
        {goal} <Badge tone={status === 'ACTIVE' ? 'good' : 'neutral'}>{status}</Badge>
      </span>
      <span className={styles.row}>
        {posts.data !== undefined && (
          <span className={styles.cardDescription}>
            {posts.data.length} {posts.data.length === 1 ? 'post' : 'posts'}
          </span>
        )}
        <Link href={`/campaigns/${campaignId}`}>Open</Link>
      </span>
    </li>
  );
}
