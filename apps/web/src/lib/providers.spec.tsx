import { useQuery } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';

import { useApi, Providers } from './providers';
import { stubApi } from '../test/harness';

/**
 * The production QueryClient lives in `Providers`. This is the one place where
 * its retry policy is defined, so the test has to exercise that instance rather
 * than a look-alike QueryClient built in the spec.
 */
function FailingBalanceQuery() {
  const api = useApi();
  const query = useQuery({
    queryKey: ['credits'],
    queryFn: () => api.credits.balance(),
  });

  return <span>{query.isError ? 'failed' : 'loading'}</span>;
}

describe('Providers retry policy', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not retry a 402 insufficient-credits response', async () => {
    const { client, calls } = stubApi({
      'GET /credits': {
        status: 402,
        body: { code: 'INSUFFICIENT_CREDITS', message: 'not enough credits' },
      },
    });

    render(
      <Providers client={client}>
        <FailingBalanceQuery />
      </Providers>,
    );

    await act(async () => {
      // Flush the first query and its error, all in fake time.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    // A 402 is a pricing decision, not a transient failure: asking twice would
    // duplicate an upsell path and still produce two failed requests.
    expect(calls).toHaveLength(1);
  });
});
