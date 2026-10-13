import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Badge, Button, Card, EmptyState, ErrorNotice, Field, LiveRegion } from './ui';

/**
 * Accessibility tests for the primitives (Phase 8 DoD: "accessible (keyboard +
 * labels)").
 *
 * These assert the behaviour the components promise, in the way a screen reader
 * or a keyboard user actually encounters it - not that an attribute is present.
 * An attribute that is present but unconnected is exactly the failure this is
 * looking for.
 */
describe('Button', () => {
  it('is reachable and operable by keyboard alone', async () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Generate</Button>);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Generate' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('fires on Space as well as Enter', async () => {
    // Space is what a button's name promises; a component that only handles
    // Enter is a div with a role on it.
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Approve</Button>);

    await userEvent.tab();
    await userEvent.keyboard(' ');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('cannot be double-submitted while busy', async () => {
    // Every mutation here either charges credits or publishes a post.
    const onClick = jest.fn();
    render(
      <Button busy onClick={onClick}>
        Generating
      </Button>,
    );

    const button = screen.getByRole('button', { name: /generating/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its accessible name while showing a spinner', () => {
    // The spinner is decorative; a name that becomes "loading" mid-flight
    // announces a different button than the one the user pressed.
    render(<Button busy>Generate reel</Button>);

    expect(screen.getByRole('button', { name: 'Generate reel' })).toBeInTheDocument();
  });
});

describe('Field', () => {
  function Harness({ error, hint }: { error?: string; hint?: string }) {
    return (
      <Field label="Campaign goal" id="goal" error={error} hint={hint}>
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
        )}
      </Field>
    );
  }

  it('associates the label with the input', async () => {
    render(<Harness />);

    const input = screen.getByLabelText('Campaign goal');
    expect(input).toBeInTheDocument();

    // Clicking the label focuses the input - the keyboard path a screen reader
    // uses.
    await userEvent.click(screen.getByText('Campaign goal'));
    expect(input).toHaveFocus();
  });

  it('describes the input with its hint', () => {
    render(<Harness hint="One sentence is enough." />);

    expect(screen.getByLabelText('Campaign goal')).toHaveAccessibleDescription(
      'One sentence is enough.',
    );
  });

  it('marks the input invalid and describes the error', () => {
    render(<Harness error="Say what the campaign is for." />);

    const input = screen.getByLabelText('Campaign goal');
    // Colour alone is not an accessible way to say a field is wrong.
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Say what the campaign is for.');
  });

  it('announces the error when it appears', () => {
    const { rerender } = render(<Harness />);
    expect(screen.queryByRole('alert')).toBeNull();

    // `role="alert"` is what makes this announced at the moment it matters.
    rerender(<Harness error="Required." />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('points at both the error and the hint when both exist', () => {
    render(<Harness error="Too short." hint="Aim for a sentence." />);

    const describedBy =
      screen.getByLabelText('Campaign goal').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
  });
});

describe('LiveRegion', () => {
  it('is invisible but announced', () => {
    render(<LiveRegion message="Plan complete" />);

    const region = screen.getByText('Plan complete');
    // `polite` so it waits for a pause rather than interrupting whatever the
    // user is doing, which matters during a multi-stage generation.
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
  });
});

describe('Card and feedback', () => {
  it('uses a heading for the title so the page has a structure', () => {
    render(
      <Card title="Credits" description="What you can spend.">
        <p>50 available</p>
      </Card>,
    );

    expect(screen.getByRole('heading', { name: 'Credits' })).toBeInTheDocument();
  });

  it('renders a title-less card without an empty header', () => {
    render(
      <Card>
        <p>body only</p>
      </Card>,
    );

    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('makes an error notice announce itself', () => {
    render(<ErrorNotice message="Could not load campaigns." />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load campaigns.');
  });

  it('offers a retry when one is possible', async () => {
    const onRetry = jest.fn();
    render(<ErrorNotice message="Could not load campaigns." onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state with a next action', () => {
    render(
      <EmptyState
        title="No campaigns yet"
        description="Describe a goal and the planner will draft posts for it."
        action={<Button variant="primary">New campaign</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No campaigns yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New campaign' })).toBeInTheDocument();
  });

  it('does not rely on colour alone for a status badge', () => {
    render(<Badge tone="good">Published</Badge>);

    // The text carries the meaning; the tone is decoration on top of it.
    expect(screen.getByText('Published')).toBeInTheDocument();
  });
});
