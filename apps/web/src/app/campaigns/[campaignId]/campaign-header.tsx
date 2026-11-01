'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { useApi } from '../../../lib/providers';
import { Icon } from '../../../components/icons';
import { Badge, PageHeader, Spinner } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * The campaign's identity, fetched rather than passed down.
 *
 * `GET /campaigns/:id` was missing before Phase 9; the page only knew the id it
 * was routed with, so a refresh showed a bare "Campaign" heading even after the
 * campaign had been renamed or finished.
 */
export function CampaignHeader({ campaignId }: { campaignId: string }) {
  const api = useApi();

  const campaign = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => api.campaigns.detail(campaignId),
  });

  if (campaign.isLoading) {
    return <Spinner label="Loading campaign" />;
  }

  if (campaign.data === undefined) {
    return (
      <PageHeader
        eyebrow="Campaign"
        title="Campaign"
        description="This campaign could not be loaded. Its posts and analytics may still be available below."
        actions={
          <Link href="/dashboard" className={styles.button}>
            <Icon name="chevronLeft" size={15} />
            Dashboard
          </Link>
        }
      />
    );
  }

  const { goal, status, startDate, endDate, brandId } = campaign.data;

  return (
    <PageHeader
      eyebrow="Campaign"
      title={goal}
      description="Write the posts, generate the assets, then send the approved ones to the calendar."
      meta={
        <>
          <Badge tone={status === 'ACTIVE' ? 'good' : 'warn'}>{status}</Badge>
          <span className={styles.tag}>
            {startDate ?? 'No start date'} → {endDate ?? 'no end date'}
          </span>
        </>
      }
      actions={
        <>
          <Link href={`/brands/${brandId}`} className={styles.button}>
            <Icon name="chevronLeft" size={15} />
            Back to brand
          </Link>
          <Link href="/calendar" className={`${styles.button} ${styles.primary}`}>
            <Icon name="calendar" size={15} />
            Open calendar
          </Link>
        </>
      }
    />
  );
}
