import type { Metadata } from 'next';

import { Calendar } from './calendar';

export const metadata: Metadata = { title: 'Calendar - RenderFlow' };

export default function CalendarPage() {
  return <Calendar />;
}
