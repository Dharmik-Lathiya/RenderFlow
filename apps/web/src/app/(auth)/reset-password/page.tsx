import type { Metadata } from 'next';

import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Choose a new password - RenderFlow',
  robots: { index: false, follow: false },
};

/**
 * `searchParams` is awaited in the server component and passed down, rather than
 * read with `useSearchParams` in the form: that hook forces a Suspense boundary
 * around the page or the production build fails, and a reset page is not worth
 * making more complicated than the thing it wraps.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  return <ResetPasswordForm token={token} />;
}
