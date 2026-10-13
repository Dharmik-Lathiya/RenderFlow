import type { Metadata } from 'next';

import { NotificationCenter } from './notification-center';

export const metadata: Metadata = { title: 'Notifications - RenderFlow' };

export default function NotificationsPage() {
  return <NotificationCenter />;
}
