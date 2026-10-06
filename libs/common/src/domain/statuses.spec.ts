import {
  isGenerationKind,
  isJobStage,
  isJobStatus,
  isSocialPlatform,
  isStageBefore,
  isTerminalJobStatus,
  isWorkspaceRole,
  JOB_STAGES,
  JOB_STAGE_SEQUENCE,
  JOB_STATUSES,
  nextJobStage,
  SOCIAL_PLATFORMS,
  TERMINAL_JOB_STATUSES,
  WORKSPACE_ROLES,
} from './statuses';

describe('job statuses', () => {
  it('recognises exactly the documented lifecycle values', () => {
    for (const status of JOB_STATUSES) {
      expect(isJobStatus(status)).toBe(true);
    }
    expect(isJobStatus('SUCCEEDED')).toBe(false);
    expect(isJobStatus(null)).toBe(false);
    expect(isJobStatus(7)).toBe(false);
  });

  it('treats COMPLETED, FAILED and CANCELLED as terminal', () => {
    expect([...TERMINAL_JOB_STATUSES]).toEqual(['COMPLETED', 'FAILED', 'CANCELLED']);
    expect(isTerminalJobStatus('COMPLETED')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('CANCELLED')).toBe(true);
    expect(isTerminalJobStatus('PENDING')).toBe(false);
    expect(isTerminalJobStatus('PROCESSING')).toBe(false);
  });
});

describe('job stages', () => {
  it('keeps the documented order used by checkpoint resume', () => {
    expect([...JOB_STAGE_SEQUENCE]).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER', 'DONE']);
    expect(JOB_STAGE_SEQUENCE).toHaveLength(JOB_STAGES.length);
  });

  it('walks forward through the sequence', () => {
    expect(nextJobStage('PLAN')).toBe('SCRIPT');
    expect(nextJobStage('SCRIPT')).toBe('IMAGE');
    expect(nextJobStage('IMAGE')).toBe('VOICE');
    expect(nextJobStage('VOICE')).toBe('RENDER');
    expect(nextJobStage('RENDER')).toBe('DONE');
  });

  it('returns null after the final stage', () => {
    expect(nextJobStage('DONE')).toBeNull();
  });

  it('returns null for a stage outside the sequence', () => {
    expect(nextJobStage('NOPE' as never)).toBeNull();
  });

  it('orders stages for resume decisions', () => {
    expect(isStageBefore('IMAGE', 'RENDER')).toBe(true);
    expect(isStageBefore('RENDER', 'IMAGE')).toBe(false);
    expect(isStageBefore('IMAGE', 'IMAGE')).toBe(false);
    expect(isStageBefore('DONE', 'PLAN')).toBe(false);
  });

  it('guards unknown stages', () => {
    expect(isJobStage('IMAGE')).toBe(true);
    expect(isJobStage('AUDIO')).toBe(false);
  });
});

describe('enum guards', () => {
  it('guards generation kinds', () => {
    expect(isGenerationKind('REEL')).toBe(true);
    expect(isGenerationKind('reel')).toBe(false);
    expect(isGenerationKind(undefined)).toBe(false);
  });

  it('guards workspace roles', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(isWorkspaceRole(role)).toBe(true);
    }
    expect(isWorkspaceRole('ADMIN')).toBe(false);
  });

  it('guards social platforms', () => {
    for (const platform of SOCIAL_PLATFORMS) {
      expect(isSocialPlatform(platform)).toBe(true);
    }
    expect(isSocialPlatform('TIKTOK')).toBe(false);
  });
});
