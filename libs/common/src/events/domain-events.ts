import { z } from 'zod';

import { GENERATION_KINDS, JOB_STAGES, SOCIAL_PLATFORMS } from '../domain/statuses';

/**
 * Domain event vocabulary. PROJECT.md section 8.
 *
 * These are the only events written to `outbox_events`. The outbox relay reads
 * them and pushes to BullMQ; workers and the API re-validate payloads with the
 * same schemas, so an untrusted or malformed message can never reach business
 * logic (AGENTS.md section 6: "Validate all external input ... queue payloads").
 */
export const DOMAIN_EVENT_TYPES = [
  'user.registered',
  'job.created',
  'job.stage_completed',
  'job.completed',
  'job.failed',
  'credits.reserved',
  'credits.refunded',
  'post.approved',
  'post.scheduled',
  'post.published',
  'post.publish_failed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Primary keys are database-generated uuids (gen_random_uuid()) everywhere. */
export const idSchema = z.uuid();

/** Credits are integers only. AGENTS.md section 7. */
export const creditAmountSchema = z.number().int().nonnegative();

export const userRegisteredEventSchema = z.object({
  eventType: z.literal('user.registered'),
  userId: idSchema,
  email: z.email(),
});

export const jobCreatedEventSchema = z.object({
  eventType: z.literal('job.created'),
  jobId: idSchema,
  userId: idSchema,
  workspaceId: idSchema,
  kind: z.enum([...GENERATION_KINDS]),
  /** Credits moved available -> reserved by the same transaction that created the job. */
  creditsReserved: creditAmountSchema,
});

export const jobStageCompletedEventSchema = z.object({
  eventType: z.literal('job.stage_completed'),
  jobId: idSchema,
  stage: z.enum([...JOB_STAGES]),
  /** Storage key of the stage artefact; also recorded in job_checkpoints. */
  outputRef: z.string().min(1),
});

export const jobCompletedEventSchema = z.object({
  eventType: z.literal('job.completed'),
  jobId: idSchema,
  postId: idSchema.nullable(),
});

export const jobFailedEventSchema = z.object({
  eventType: z.literal('job.failed'),
  jobId: idSchema,
  /** `TRANSIENT` is retryable within attempts, `PERMANENT` fails immediately. */
  classification: z.enum(['TRANSIENT', 'PERMANENT']),
  reason: z.string().min(1),
  attempts: z.number().int().nonnegative(),
});

export const creditsReservedEventSchema = z.object({
  eventType: z.literal('credits.reserved'),
  userId: idSchema,
  jobId: idSchema,
  amount: creditAmountSchema,
});

export const creditsRefundedEventSchema = z.object({
  eventType: z.literal('credits.refunded'),
  userId: idSchema,
  jobId: idSchema,
  amount: creditAmountSchema,
});

export const postApprovedEventSchema = z.object({
  eventType: z.literal('post.approved'),
  postId: idSchema,
  approvedBy: idSchema,
});

export const postScheduledEventSchema = z.object({
  eventType: z.literal('post.scheduled'),
  postId: idSchema,
  scheduledAt: z.iso.datetime(),
  publishJobIds: z.array(idSchema).min(1),
});

export const postPublishedEventSchema = z.object({
  eventType: z.literal('post.published'),
  postId: idSchema,
  publishJobId: idSchema,
  platform: z.enum([...SOCIAL_PLATFORMS]),
  externalPostId: z.string().min(1),
});

export const postPublishFailedEventSchema = z.object({
  eventType: z.literal('post.publish_failed'),
  postId: idSchema,
  publishJobId: idSchema,
  platform: z.enum([...SOCIAL_PLATFORMS]),
  reason: z.string().min(1),
});

/**
 * Discriminated on `eventType`, so `parseDomainEvent` narrows the payload type
 * for the caller and an unknown event type is a validation error.
 */
export const domainEventSchema = z.discriminatedUnion('eventType', [
  userRegisteredEventSchema,
  jobCreatedEventSchema,
  jobStageCompletedEventSchema,
  jobCompletedEventSchema,
  jobFailedEventSchema,
  creditsReservedEventSchema,
  creditsRefundedEventSchema,
  postApprovedEventSchema,
  postScheduledEventSchema,
  postPublishedEventSchema,
  postPublishFailedEventSchema,
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;

/** Row shape of `outbox_events` as it leaves the database. */
export const outboxEnvelopeSchema = z.object({
  eventId: idSchema,
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  event: domainEventSchema,
});

export type OutboxEnvelope = z.infer<typeof outboxEnvelopeSchema>;

export function parseDomainEvent(input: unknown): DomainEvent {
  return domainEventSchema.parse(input);
}

export function parseOutboxEnvelope(input: unknown): OutboxEnvelope {
  return outboxEnvelopeSchema.parse(input);
}

/**
 * Payload placed on a BullMQ queue for a generation job.
 *
 * Distinct from the domain event: the outbox event is the durable record in
 * Postgres, this is the ephemeral message handed to a worker.
 */
export const generationTaskSchema = z.object({
  jobId: idSchema,
  kind: z.enum([...GENERATION_KINDS]),
  userId: idSchema,
  workspaceId: idSchema,
  attempt: z.number().int().positive(),
  payload: z.unknown(),
});

export type GenerationTask = z.infer<typeof generationTaskSchema>;

export function parseGenerationTask(input: unknown): GenerationTask {
  return generationTaskSchema.parse(input);
}
