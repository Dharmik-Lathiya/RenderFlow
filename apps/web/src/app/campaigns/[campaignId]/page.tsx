import Link from 'next/link';

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
      <h1>Campaign</h1>
      <CampaignPosts campaignId={campaignId} />
    </>
  );
}
