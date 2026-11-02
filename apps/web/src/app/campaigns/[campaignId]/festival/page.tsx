import { FestivalStudio } from './festival-studio';

export default async function FestivalPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  return <FestivalStudio campaignId={campaignId} />;
}
