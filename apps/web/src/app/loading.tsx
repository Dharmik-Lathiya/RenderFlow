import { Skeleton } from '../components/ui';

/**
 * Segment loading state.
 *
 * The pages that need one are server-rendered and hit the API (the pricing
 * page and the dashboard); without this, navigation shows a frozen previous
 * screen with no indication that anything is happening.
 *
 * Renders a skeleton rather than visible "Loading…" text; the announcement is
 * kept for assistive technology inside the skeleton's live region.
 */
export default function Loading() {
  return <Skeleton />;
}
