/**
 * Shared domain vocabulary.
 *
 * AGENTS.md section 7: "Use enums/union types from libs/common for statuses and
 * event types; no magic strings." Every status that crosses a process boundary
 * (HTTP, queue payload, DB column) is declared here exactly once.
 *
 * These are plain `as const` arrays rather than TS `enum`s so the values survive
 * `isolatedModules`, are trivially serialisable to JSON, and can be fed directly
 * to zod via `z.enum(...)`.
 */

/** Generation job lifecycle. PROJECT.md section 7. */
export const JOB_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Job status values after which no further transition is legal. */
export const TERMINAL_JOB_STATUSES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly JobStatus[];
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalJobStatus(value: JobStatus): value is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Ordered generation stages. The order matters: checkpoint resume (Phase 5)
 * restarts a job at the first stage that has no `job_checkpoints` row.
 */
export const JOB_STAGES = ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER', 'DONE'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** Ordered copy, useful where a mutable sequence is needed. */
export const JOB_STAGE_SEQUENCE: readonly JobStage[] = JOB_STAGES;

export function isJobStage(value: unknown): value is JobStage {
  return typeof value === 'string' && (JOB_STAGES as readonly string[]).includes(value);
}

/** The stage after `stage`, or `null` when `stage` is the last one. */
export function nextJobStage(stage: JobStage): JobStage | null {
  const index = JOB_STAGE_SEQUENCE.indexOf(stage);
  if (index < 0) {
    return null;
  }
  return JOB_STAGE_SEQUENCE[index + 1] ?? null;
}

/** True when `candidate` runs strictly before `reference` in the stage sequence. */
export function isStageBefore(candidate: JobStage, reference: JobStage): boolean {
  return JOB_STAGE_SEQUENCE.indexOf(candidate) < JOB_STAGE_SEQUENCE.indexOf(reference);
}

/** Post lifecycle. PROJECT.md section 6. */
export const POST_STATUSES = [
  'DRAFT',
  'GENERATING',
  'READY',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export function isPostStatus(value: unknown): value is PostStatus {
  return typeof value === 'string' && (POST_STATUSES as readonly string[]).includes(value);
}

/** Publish job lifecycle. PROJECT.md section 7. */
export const PUBLISH_STATUSES = [
  'SCHEDULED',
  'QUEUED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

/**
 * Paid units of work. Each maps 1:1 to a `pricing_rules.action` row, which is
 * the only source of truth for cost (AGENTS.md rule 7).
 */
export const GENERATION_KINDS = [
  'CONTENT_PLAN',
  'CAPTION',
  'POSTER',
  'CAROUSEL',
  'REEL',
  'REGENERATE_SCENE',
  'TRANSLATION',
] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

export function isGenerationKind(value: unknown): value is GenerationKind {
  return typeof value === 'string' && (GENERATION_KINDS as readonly string[]).includes(value);
}

/** Credit ledger entry types. PROJECT.md section 5.3. */
export const CREDIT_ENTRY_TYPES = [
  'SIGNUP_BONUS',
  'PURCHASE',
  'RESERVE',
  'CAPTURE',
  'REFUND',
  'ADJUSTMENT',
  'EXPIRY',
] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

/** Workspace membership roles, most privileged first. PROJECT.md section 6. */
export const WORKSPACE_ROLES = ['OWNER', 'EDITOR', 'APPROVER', 'VIEWER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Social platforms. PROJECT.md section 1: Instagram + LinkedIn in v1. */
export const SOCIAL_PLATFORMS = ['INSTAGRAM', 'LINKEDIN'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/** Connection state of a linked social account. PROJECT.md section 13.3 (R11). */
export const SOCIAL_ACCOUNT_STATUSES = ['ACTIVE', 'NEEDS_REAUTH', 'DISCONNECTED'] as const;
export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

/** Global (not workspace-scoped) user role; drives the `/admin/*` surface. */
export const USER_ROLES = ['ADMIN', 'MEMBER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Asset kinds produced by the media pipeline. */
export const ASSET_TYPES = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
