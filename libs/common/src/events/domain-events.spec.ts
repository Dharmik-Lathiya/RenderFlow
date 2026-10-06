import {
  DOMAIN_EVENT_TYPES,
  domainEventSchema,
  generationTaskSchema,
  parseDomainEvent,
  parseGenerationTask,
  parseOutboxEnvelope,
} from './domain-events';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const POST_ID = '44444444-4444-4444-8444-444444444444';
const PUBLISH_JOB_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';

describe('parseDomainEvent', () => {
  it('accepts user.registered', () => {
    const event = parseDomainEvent({
      eventType: 'user.registered',
      userId: USER_ID,
      email: 'founder@example.com',
    });
    expect(event.eventType).toBe('user.registered');
  });

  it('rejects a malformed email on user.registered', () => {
    expect(() =>
      parseDomainEvent({ eventType: 'user.registered', userId: USER_ID, email: 'not-an-email' }),
    ).toThrow();
  });

  it('accepts job.created with an integer credit amount', () => {
    const event = parseDomainEvent({
      eventType: 'job.created',
      jobId: JOB_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      kind: 'REEL',
      creditsReserved: 30,
    });
    expect(event).toMatchObject({ eventType: 'job.created', creditsReserved: 30 });
  });

  it('rejects fractional credits', () => {
    expect(() =>
      parseDomainEvent({
        eventType: 'job.created',
        jobId: JOB_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        kind: 'REEL',
        creditsReserved: 30.5,
      }),
    ).toThrow();
  });

  it('rejects negative credits', () => {
    expect(() =>
      parseDomainEvent({
        eventType: 'job.created',
        jobId: JOB_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        kind: 'REEL',
        creditsReserved: -30,
      }),
    ).toThrow();
  });

  it('rejects an unknown generation kind', () => {
    expect(() =>
      parseDomainEvent({
        eventType: 'job.created',
        jobId: JOB_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        kind: 'HOLOGRAM',
        creditsReserved: 1,
      }),
    ).toThrow();
  });

  it('rejects a non-uuid job id', () => {
    expect(() =>
      parseDomainEvent({
        eventType: 'job.created',
        jobId: 'not-a-uuid',
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        kind: 'REEL',
        creditsReserved: 30,
      }),
    ).toThrow();
  });

  it('accepts job.stage_completed for every stage', () => {
    for (const stage of ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER', 'DONE']) {
      const event = parseDomainEvent({
        eventType: 'job.stage_completed',
        jobId: JOB_ID,
        stage,
        outputRef: `jobs/${JOB_ID}/${stage}.json`,
      });
      expect(event).toMatchObject({ eventType: 'job.stage_completed', stage });
    }
  });

  it('accepts job.failed with a retry classification', () => {
    const transient = parseDomainEvent({
      eventType: 'job.failed',
      jobId: JOB_ID,
      classification: 'TRANSIENT',
      reason: 'image provider 503',
      attempts: 1,
    });
    expect(transient).toMatchObject({ classification: 'TRANSIENT' });

    const permanent = parseDomainEvent({
      eventType: 'job.failed',
      jobId: JOB_ID,
      classification: 'PERMANENT',
      reason: 'moderation',
      attempts: 1,
    });
    expect(permanent).toMatchObject({ classification: 'PERMANENT' });
  });

  it('accepts post.published with an external post id', () => {
    const event = parseDomainEvent({
      eventType: 'post.published',
      postId: POST_ID,
      publishJobId: PUBLISH_JOB_ID,
      platform: 'LINKEDIN',
      externalPostId: 'urn:li:share:123',
    });
    expect(event).toMatchObject({ eventType: 'post.published', platform: 'LINKEDIN' });
  });

  it('rejects an unsupported platform on post.published', () => {
    expect(() =>
      parseDomainEvent({
        eventType: 'post.published',
        postId: POST_ID,
        publishJobId: PUBLISH_JOB_ID,
        platform: 'MYSPACE',
        externalPostId: 'x',
      }),
    ).toThrow();
  });

  it('rejects an unknown event type', () => {
    expect(() => parseDomainEvent({ eventType: 'job.exploded', jobId: JOB_ID })).toThrow();
  });

  it('rejects a missing discriminator', () => {
    expect(() => parseDomainEvent({ jobId: JOB_ID })).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => parseDomainEvent('job.created')).toThrow();
    expect(() => parseDomainEvent(null)).toThrow();
  });
});

describe('domainEventSchema coverage', () => {
  it('every declared event type is a member of the union', () => {
    expect(domainEventSchema.def.options.map((option) => option.shape.eventType.value)).toEqual([
      ...DOMAIN_EVENT_TYPES,
    ]);
  });
});

describe('parseOutboxEnvelope', () => {
  it('accepts a well-formed outbox row', () => {
    const envelope = parseOutboxEnvelope({
      eventId: EVENT_ID,
      aggregateType: 'JOB',
      aggregateId: JOB_ID,
      occurredAt: '2026-01-02T03:04:05.000Z',
      event: {
        eventType: 'job.completed',
        jobId: JOB_ID,
        postId: POST_ID,
      },
    });
    expect(envelope.aggregateType).toBe('JOB');
    expect(envelope.event.eventType).toBe('job.completed');
  });

  it('accepts a null postId on job.completed', () => {
    const envelope = parseOutboxEnvelope({
      eventId: EVENT_ID,
      aggregateType: 'JOB',
      aggregateId: JOB_ID,
      occurredAt: '2026-01-02T03:04:05.000Z',
      event: { eventType: 'job.completed', jobId: JOB_ID, postId: null },
    });
    expect(envelope.event).toMatchObject({ eventType: 'job.completed', postId: null });
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() =>
      parseOutboxEnvelope({
        eventId: EVENT_ID,
        aggregateType: 'JOB',
        aggregateId: JOB_ID,
        occurredAt: 'yesterday',
        event: { eventType: 'job.completed', jobId: JOB_ID, postId: null },
      }),
    ).toThrow();
  });

  it('rejects an outbox row whose payload does not match its event type', () => {
    expect(() =>
      parseOutboxEnvelope({
        eventId: EVENT_ID,
        aggregateType: 'JOB',
        aggregateId: JOB_ID,
        occurredAt: '2026-01-02T03:04:05.000Z',
        event: { eventType: 'post.approved', jobId: JOB_ID, approvedBy: USER_ID },
      }),
    ).toThrow();
  });
});

describe('parseGenerationTask', () => {
  const task = {
    jobId: JOB_ID,
    kind: 'REEL',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    attempt: 1,
    payload: { goal: 'Diwali sale' },
  };

  it('accepts the queue payload shape', () => {
    expect(parseGenerationTask(task)).toMatchObject({ kind: 'REEL', attempt: 1 });
  });

  it('rejects attempt 0 (bullmq attempts are 1-based)', () => {
    expect(() => parseGenerationTask({ ...task, attempt: 0 })).toThrow();
  });

  it('rejects a missing workspaceId', () => {
    const { workspaceId: _omitted, ...rest } = task;
    expect(() => parseGenerationTask(rest)).toThrow();
  });

  it('rejects a job payload with an arbitrary shape only at the edge', () => {
    // `payload` is opaque here; the worker validates its own stage inputs.
    expect(generationTaskSchema.safeParse({ ...task, payload: 'anything' }).success).toBe(true);
  });
});
