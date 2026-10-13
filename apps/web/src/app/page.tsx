import { redirect } from 'next/navigation';

/**
 * The Phase 0 landing page, retired.
 *
 * It used to prove the app built. Now that there are real screens, a visitor who
 * lands here unauthenticated should be sent to sign in rather than read a page
 * about the repository layout - so the routing lives in the dashboard itself,
 * which knows whether there is a session.
 */
export default function Home(): never {
  redirect('/dashboard');
}
