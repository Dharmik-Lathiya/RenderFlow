import type { Metadata } from 'next';

import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = {
  title: 'Reset your password - RenderFlow',
  description: 'Request a password reset link for your RenderFlow account.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
