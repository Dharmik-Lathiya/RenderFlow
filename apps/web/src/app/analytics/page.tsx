import type { Metadata } from 'next';

import { AnalyticsOverview } from './analytics-overview';

export const metadata: Metadata = { title: 'Analytics - RenderFlow' };

export default function AnalyticsPage() {
  return <AnalyticsOverview />;
}
