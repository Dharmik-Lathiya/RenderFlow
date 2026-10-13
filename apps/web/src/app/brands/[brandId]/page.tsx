import { BrandDetail } from './brand-detail';

export default async function BrandPage({ params }: { params: Promise<{ brandId: string }> }) {
  // `await params`: in the App Router these are a promise, and reading them
  // synchronously type-checks in some versions and throws in others.
  const { brandId } = await params;

  return <BrandDetail brandId={brandId} />;
}
