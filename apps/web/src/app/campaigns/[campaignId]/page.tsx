import Link from 'next/link';

import { CampaignAnalytics } from './campaign-analytics';
import { CampaignHeader } from './campaign-header';
import { CampaignPosts } from './campaign-posts';

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <CampaignHeader campaignId={campaignId} />
      <CampaignPosts campaignId={campaignId} />
      <CampaignAnalytics campaignId={campaignId} />
    </>
  );
}
