'use client';

/**
 * Route error boundary.
 *
 * A client component by requirement: `reset` re-renders the segment. The message
 * shown is deliberately generic - a stack trace is not useful to a customer and
 * may carry internal detail - but the digest is displayed so a support request can
 * be matched to a server log. Next already reports the error with that digest, so
 * this component does not log it a second time.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>
        This screen failed to render. Nothing was charged, and no job was cancelled - generation and
        publishing run in separate processes and are unaffected by a page error.
      </p>
      {error.digest === undefined ? null : (
        <p>
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>
    </>
  );
}
