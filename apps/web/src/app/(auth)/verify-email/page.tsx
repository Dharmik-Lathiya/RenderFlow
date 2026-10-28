import type { Metadata } from 'next';

import { VerifyEmailForm } from './verify-email-form';

export const metadata: Metadata = {
  title: 'Confirm your email - RenderFlow',
  robots: { index: false, follow: false },
};

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  return <VerifyEmailForm token={token} />;
}
