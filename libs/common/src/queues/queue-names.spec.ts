import {
  ALL_QUEUE_NAMES,
  GENERATION_QUEUE_BY_KIND,
  QUEUE_NAMES,
  isQueueName,
  queueForGenerationKind,
} from './queue-names';

describe('queue names', () => {
  it('matches the queues declared in PROJECT.md section 8', () => {
    expect(ALL_QUEUE_NAMES).toEqual([
      'content',
      'media',
      'publish',
      'analytics',
      'notifications',
      'dlq',
    ]);
  });

  it('guards queue names', () => {
    expect(isQueueName('content')).toBe(true);
    expect(isQueueName('dlq')).toBe(true);
    expect(isQueueName('email')).toBe(false);
    expect(isQueueName(42)).toBe(false);
  });
});

describe('queueForGenerationKind', () => {
  it('routes LLM work to content and media work to media', () => {
    expect(queueForGenerationKind('CONTENT_PLAN')).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForGenerationKind('CAPTION')).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForGenerationKind('TRANSLATION')).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForGenerationKind('POSTER')).toBe(QUEUE_NAMES.MEDIA);
    expect(queueForGenerationKind('CAROUSEL')).toBe(QUEUE_NAMES.MEDIA);
    expect(queueForGenerationKind('REEL')).toBe(QUEUE_NAMES.MEDIA);
    expect(queueForGenerationKind('REGENERATE_SCENE')).toBe(QUEUE_NAMES.MEDIA);
  });

  it('routes publish work to the publish queue', () => {
    // Sanity check that publish is a first-class queue, not derived from kinds.
    expect(QUEUE_NAMES.PUBLISH).toBe('publish');
    expect(GENERATION_QUEUE_BY_KIND).not.toHaveProperty('PUBLISH');
  });

  it('returns null for an unknown kind rather than guessing', () => {
    expect(queueForGenerationKind('HOLOGRAM')).toBeNull();
  });
});
