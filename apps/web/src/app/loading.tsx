/**
 * Segment loading state.
 *
 * The pages that need one are server-rendered and hit the API (the pricing page
 * and the dashboard); without this, navigation shows a frozen previous screen with
 * no indication that anything is happening.
 *
 * `aria-live` announces it once, without stealing focus.
 */
export default function Loading() {
  return (
    <p role="status" aria-live="polite">
      Loading…
    </p>
  );
}
