'use client';

import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../../lib/providers';
import { Badge, Spinner } from '../../../components/ui';
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
    return <h1>Campaign</h1>;
  }

  return (
    <>
      <h1>{campaign.data.goal}</h1>
      <p className={styles.row}>
        <Badge tone={campaign.data.status === 'ACTIVE' ? 'good' : 'warn'}>
          {campaign.data.status}
        </Badge>
        <span className={styles.cardDescription}>
          {campaign.data.startDate ?? 'No start date'} → {campaign.data.endDate ?? 'no end date'}
        </span>
      </p>
    </>
  );
}
