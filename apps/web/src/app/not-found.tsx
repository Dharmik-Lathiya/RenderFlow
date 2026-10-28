import Link from 'next/link';

/**
 * 404.
 *
 * Renders inside the app shell, because the common case is a signed-in user
 * following a stale link to a post or brand. Public visitors get the shell's
 * "signed out" state with a link back to the landing page, which is still a way
 * out rather than a dead end.
 */
export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        That page does not exist, or the thing it pointed at was deleted. Nothing was charged for
        this.
      </p>
      <p>
        <Link href="/dashboard">Back to the dashboard</Link>
        {' · '}
        <Link href="/">Public site</Link>
      </p>
    </>
  );
}
