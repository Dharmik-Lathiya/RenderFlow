import { act, render, renderHook, screen } from '@testing-library/react';

import type { Job } from '@renderflow/api-client';

import { stubResponse } from '../../../../test/setup';

import { JobProgressView, useJobProgress, type JobProgress } from './job-progress';

/**
 * The progress view.
 *
 * A festival job runs PLAN -> SCRIPT -> IMAGE and, when it includes a reel,
 * RENDER. It never runs VOICE. Showing the default five-stage list made the bar
 * stop at 60% on a finished poster and implied a stage had been skipped.
 */

function progress(kind: string, stage: string, completedStages: string[]): JobProgress {
  const job: Job = {
    id: 'j1',
    postId: 'p1',
    kind,
    status: 'PROCESSING',
    stage,
    creditsReserved: 6,
    refunded: false,
    captured: false,
    error: null,
    completedStages,
    createdAt: '2026-11-01T00:00:00.000Z',
    finishedAt: null,
  };

  return { job, stage, completed: completedStages, connecting: false };
}

type Listener = (event: Event) => void;

/** A controllable EventSource: jsdom has none, and a real one would be a network test. */
class StubEventSource {
  static instances: StubEventSource[] = [];

  readonly listeners = new Map<string, Set<Listener>>();
  readonly close = jest.fn(() => {
    this.closed = true;
  });
  closed = false;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== 'function') {
      return;
    }
    const forType = this.listeners.get(type) ?? new Set<Listener>();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  emit(type: string, data?: string): void {
    const event = Object.assign(new Event(type), data === undefined ? {} : { data });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function onlySource(): StubEventSource {
  const source = StubEventSource.instances[0];
  if (source === undefined) {
    throw new Error('expected one EventSource');
  }
  return source;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    postId: 'p1',
    kind: 'CAPTION',
    status: 'PROCESSING',
    stage: 'PLAN',
    creditsReserved: 6,
    refunded: false,
    captured: false,
    error: null,
    completedStages: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('JobProgressView', () => {
  it('shows only the stages a festival poster will run', () => {
    render(<JobProgressView progress={progress('FESTIVAL_IMAGE', 'SCRIPT', ['PLAN'])} />);

    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(screen.getByText('script')).toBeInTheDocument();
    expect(screen.getByText('image')).toBeInTheDocument();
    expect(screen.queryByText('voice')).not.toBeInTheDocument();
    expect(screen.queryByText('render')).not.toBeInTheDocument();

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '3');
  });

  it('adds RENDER but still omits VOICE for a festival reel', () => {
    render(<JobProgressView progress={progress('FESTIVAL_REEL', 'IMAGE', ['PLAN', 'SCRIPT'])} />);

    expect(screen.getByText('render')).toBeInTheDocument();
    expect(screen.queryByText('voice')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '4');
  });

  it('keeps the five-stage pipeline for an ordinary reel', () => {
    render(<JobProgressView progress={progress('REEL', 'VOICE', ['PLAN', 'SCRIPT', 'IMAGE'])} />);

    expect(screen.getByText('voice')).toBeInTheDocument();
    expect(screen.getByText('render')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
  });
});

describe('useJobProgress lifecycle', () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    StubEventSource.instances = [];
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    fetchMock = jest.fn(() => Promise.resolve(stubResponse(200, job())));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
  });

  async function startFallbackPoll(): Promise<{
    source: StubEventSource;
    unmount: () => void;
  }> {
    const hook = renderHook(() => useJobProgress('j1'));
    const source = onlySource();
    act(() => {
      source.emit('error');
    });
    await act(async () => {
      // One poll tick. Fake timers keep this deterministic; no wall-clock wait.
      jest.advanceTimersByTime(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return { source, unmount: hook.unmount };
  }

  it('stops the fallback poll when a terminal checkpoint arrives', async () => {
    const { result } = renderHook(() => useJobProgress('j1'));
    const source = onlySource();
    act(() => {
      source.emit('error');
    });
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      source.emit(
        'progress',
        JSON.stringify(job({ status: 'COMPLETED', completedStages: ['PLAN'] })),
      );
    });

    expect(result.current.job?.status).toBe('COMPLETED');
    expect(source.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling and closes the stream when the server sends done', async () => {
    const { source } = await startFallbackPoll();

    act(() => {
      source.emit('done', JSON.stringify({ status: 'COMPLETED' }));
    });

    expect(source.close).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears an active poll and closes the stream when the hook unmounts', async () => {
    const { source, unmount } = await startFallbackPoll();
    expect(source.closed).toBe(false);

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an unparseable progress frame instead of casting it into job state', () => {
    const { result } = renderHook(() => useJobProgress('j1'));

    act(() => {
      onlySource().emit('progress', JSON.stringify({ not: 'a job' }));
    });

    expect(result.current.job).toBeNull();
  });
});
