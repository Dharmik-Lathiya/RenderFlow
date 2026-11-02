import { render, screen } from '@testing-library/react';

import type { Job } from '@renderflow/api-client';

import { JobProgressView, type JobProgress } from './job-progress';

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
