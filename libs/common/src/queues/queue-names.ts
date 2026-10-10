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

/**
 * Which queue owns a pipeline stage.
 *
 * A generation job is split across two workers: LLM stages on `content`, image
 * / TTS / render on `media`. Routing by STAGE rather than by job kind is what
 * lets a reel cross from one worker to the other - `job.created` starts on
 * `content`, and each `job.stage_completed` hands the job to whoever owns the
 * next stage.
 *
 * The split is about the shape of the work, not about which queue is cheaper.
 * Media concurrency is 2 against 5 for content precisely because rendering is
 * CPU bound while an LLM call is mostly waiting on a socket.
 */
export const STAGE_QUEUE_BY_NAME: Readonly<Record<string, QueueName>> = {
  PLAN: QUEUE_NAMES.CONTENT,
  SCRIPT: QUEUE_NAMES.CONTENT,
  IMAGE: QUEUE_NAMES.MEDIA,
  VOICE: QUEUE_NAMES.MEDIA,
  RENDER: QUEUE_NAMES.MEDIA,
};

export function queueForJobStage(stage: string): QueueName | null {
  return STAGE_QUEUE_BY_NAME[stage] ?? null;
}

/** Every stage a worker queue is responsible for, in pipeline order. */
export function stagesForQueue(queue: QueueName): readonly string[] {
  return Object.entries(STAGE_QUEUE_BY_NAME)
    .filter(([, owner]) => owner === queue)
    .map(([stage]) => stage);
}
