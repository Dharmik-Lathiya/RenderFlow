'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
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
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>{brand.data.name}</h1>
      {brand.data.industry !== null && (
        <p className={styles.cardDescription}>{brand.data.industry}</p>
      )}

      <Card
        title="New campaign"
        description="Describe what you want to achieve. The planner drafts posts for it."
      >
        <form
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

      <Card title="Campaigns">
        {campaigns.isLoading && <Spinner label="Loading campaigns" />}

        {campaigns.isError && (
          <ErrorNotice
            message="Could not load campaigns."
            onRetry={() => void campaigns.refetch()}
          />
        )}

        {campaigns.data !== undefined && campaigns.data.length === 0 && (
          <EmptyState
            title="No campaigns yet"
            description="Describe a goal above and the planner will draft posts for it."
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
      <span>
        {posts.data !== undefined && (
          <span className={styles.cardDescription}>
            {' '}
            {posts.data.length} {posts.data.length === 1 ? 'post' : 'posts'}
          </span>
        )}
        <Link href={`/campaigns/${campaignId}`}>Open</Link>
      </span>
    </li>
  );
}
