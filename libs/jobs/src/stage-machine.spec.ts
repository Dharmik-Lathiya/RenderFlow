import {
  JOB_STATUS_TRANSITIONS,
  STAGES,
  START_STAGE_BY_KIND,
  TERMINAL_STAGE,
  assertStageOrder,
  canTransition,
  fullStageSequence,
  isPipelineComplete,
  resumeStage,
  stageApplies,
  stagesFor,
} from './stage-machine';
import { GENERATION_KINDS, JOB_STAGES } from '@renderflow/common';

/**
 * The stage machine.
 *
 * Exhaustive rather than sampled: this is a finite table, and every entry in it
 * is a rule the runner depends on. A gap here does not throw - it produces a job
 * that renders with no scenes, or one that never completes, both of which are
 * expensive to notice.
 */
describe('assertStageOrder', () => {
  it('agrees with the shared JOB_STAGES vocabulary', () => {
    // The runner and libs/common must not disagree about what comes next.
    expect(() => assertStageOrder()).not.toThrow();
    expect(STAGES).toEqual([...JOB_STAGES]);
  });
});

describe('START_STAGE_BY_KIND', () => {
  it('covers every generation kind', () => {
    for (const kind of GENERATION_KINDS) {
      expect(START_STAGE_BY_KIND[kind]).toBeDefined();
    }
    expect(Object.keys(START_STAGE_BY_KIND).sort()).toEqual([...GENERATION_KINDS].sort());
  });

  it('starts a reel at PLAN, since it needs script and images first', () => {
    expect(START_STAGE_BY_KIND.REEL).toBe('PLAN');
  });

  it('starts a single poster at IMAGE, since the caption is the whole job', () => {
    expect(START_STAGE_BY_KIND.POSTER).toBe('IMAGE');
  });

  it('starts a caption at SCRIPT', () => {
    expect(START_STAGE_BY_KIND.CAPTION).toBe('SCRIPT');
  });
});

describe('stagesFor', () => {
  it('runs every stage for a reel except DONE', () => {
    expect(stagesFor('REEL')).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
  });

  it('never includes DONE, which is a marker rather than work', () => {
    for (const kind of GENERATION_KINDS) {
      expect(stagesFor(kind)).not.toContain(TERMINAL_STAGE);
    }
  });

  it('runs only IMAGE for a poster, with no narration or render', () => {
    expect(stagesFor('POSTER')).toEqual(['IMAGE']);
  });

  it('runs only SCRIPT for a caption', () => {
    expect(stagesFor('CAPTION')).toEqual(['SCRIPT']);
  });

  it('runs every stage for a reel', () => {
    expect(stagesFor('REEL')).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
  });
});

describe('fullStageSequence', () => {
  it('includes the terminal DONE marker', () => {
    expect(fullStageSequence('REEL')).toEqual([
      'PLAN',
      'SCRIPT',
      'IMAGE',
      'VOICE',
      'RENDER',
      'DONE',
    ]);
    // A poster runs IMAGE only, then DONE. Deriving this by slicing from IMAGE to
    // the end of the stage list is what made a poster render a video.
    expect(fullStageSequence('POSTER')).toEqual(['IMAGE', 'DONE']);
  });
});

describe('resumeStage', () => {
  it('starts at the beginning when nothing is checkpointed', () => {
    expect(resumeStage('REEL', [])).toBe('PLAN');
    expect(resumeStage('POSTER', [])).toBe('IMAGE');
  });

  it('skips stages already checkpointed', () => {
    expect(resumeStage('REEL', ['PLAN'])).toBe('SCRIPT');
    expect(resumeStage('REEL', ['PLAN', 'SCRIPT'])).toBe('IMAGE');
  });

  it('resumes at the FIRST gap, not the last completed stage', () => {
    // A later artefact may depend on an earlier one that was never produced, so
    // resuming from the end would produce a reel assembled from nothing.
    expect(resumeStage('REEL', ['PLAN', 'IMAGE'])).toBe('SCRIPT');
  });

  it('ignores checkpoints for stages this kind never runs', () => {
    // Stale rows must not make a poster look finished.
    expect(resumeStage('POSTER', ['PLAN', 'SCRIPT', 'VOICE'])).toBe('IMAGE');
  });

  it('reports DONE when everything is checkpointed', () => {
    expect(resumeStage('POSTER', ['IMAGE'])).toBe(TERMINAL_STAGE);
    expect(resumeStage('REEL', ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER'])).toBe(
      TERMINAL_STAGE,
    );
  });

  it('does not report DONE for a poster that only has later stages', () => {
    // VOICE and RENDER are not stages a poster runs, so they do not complete it.
    expect(resumeStage('POSTER', ['VOICE', 'RENDER'])).toBe('IMAGE');
  });
});

describe('isPipelineComplete', () => {
  it('is false when a stage the kind needs is missing', () => {
    expect(isPipelineComplete('POSTER', [])).toBe(false);
    expect(isPipelineComplete('REEL', ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE'])).toBe(false);
  });

  it('is true once every stage the kind runs is present', () => {
    expect(isPipelineComplete('POSTER', ['IMAGE'])).toBe(true);
    expect(isPipelineComplete('REEL', ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER'])).toBe(true);
    expect(isPipelineComplete('CAPTION', ['SCRIPT'])).toBe(true);
  });

  it('ignores checkpoints for stages the kind never runs', () => {
    // A poster carrying VOICE and RENDER checkpoints from an earlier attempt is
    // complete because it has IMAGE, not because it has everything.
    expect(isPipelineComplete('POSTER', ['IMAGE', 'VOICE', 'RENDER'])).toBe(true);
    expect(isPipelineComplete('CAPTION', ['IMAGE', 'VOICE'])).toBe(false);
  });
});

describe('stageApplies', () => {
  it('is false for stages a kind skips', () => {
    expect(stageApplies('POSTER', 'PLAN')).toBe(false);
    expect(stageApplies('POSTER', 'IMAGE')).toBe(true);
  });
});

describe('JOB_STATUS_TRANSITIONS', () => {
  it('treats terminal statuses as terminal', () => {
    // Nothing may leave COMPLETED/FAILED/CANCELLED: the credits are already
    // settled and a second transition would try to move them again.
    for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED']) {
      expect(JOB_STATUS_TRANSITIONS[terminal]).toEqual([]);
      for (const to of ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('allows a pending job to start processing', () => {
    expect(canTransition('PENDING', 'PROCESSING')).toBe(true);
  });

  it('allows a processing job to finish, fail or be cancelled', () => {
    expect(canTransition('PROCESSING', 'COMPLETED')).toBe(true);
    expect(canTransition('PROCESSING', 'FAILED')).toBe(true);
    expect(canTransition('PROCESSING', 'CANCELLED')).toBe(true);
  });

  it('does not allow a job to go backwards', () => {
    expect(canTransition('PROCESSING', 'PENDING')).toBe(false);
    expect(canTransition('COMPLETED', 'PROCESSING')).toBe(false);
  });

  it('treats an unknown status as having no legal transitions', () => {
    expect(canTransition('NONSENSE', 'PENDING')).toBe(false);
  });
});

describe('stage ordering is shared, not duplicated', () => {
  it('matches JOB_STAGES exactly', () => {
    expect([...STAGES]).toEqual([...JOB_STAGES]);
  });

  it('starts every kind at a real stage', () => {
    for (const kind of GENERATION_KINDS) {
      expect(JOB_STAGES).toContain(START_STAGE_BY_KIND[kind]);
    }
  });
});
