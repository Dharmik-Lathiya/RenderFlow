/**
 * Queue names. PROJECT.md section 8.
 *
 * Declared in libs/common (not libs/queue) because the API, every worker and the
 * outbox relay all need to name the same queues, and libs/queue depends on
 * libs/common - not the other way round.
 */
export const QUEUE_NAMES = {
  CONTENT: 'content',
  MEDIA: 'media',
  PUBLISH: 'publish',
  ANALYTICS: 'analytics',
  NOTIFICATIONS: 'notifications',
  DLQ: 'dlq',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === 'string' && (ALL_QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * Which queue a generation job belongs to. The outbox relay uses this to route
 * `job.created` events after the relay has read them out of Postgres.
 */
export const GENERATION_QUEUE_BY_KIND: Readonly<Record<string, QueueName>> = {
  CONTENT_PLAN: QUEUE_NAMES.CONTENT,
  CAPTION: QUEUE_NAMES.CONTENT,
  TRANSLATION: QUEUE_NAMES.CONTENT,
  POSTER: QUEUE_NAMES.MEDIA,
  CAROUSEL: QUEUE_NAMES.MEDIA,
  REEL: QUEUE_NAMES.MEDIA,
  REGENERATE_SCENE: QUEUE_NAMES.MEDIA,
};

export function queueForGenerationKind(kind: string): QueueName | null {
  return GENERATION_QUEUE_BY_KIND[kind] ?? null;
}
