import { screen, waitFor } from '@testing-library/react';

import { FestivalStudio } from './festival-studio';
import { renderWithProviders, stubApi, userEvent } from '../../../../test/harness';

/**
 * The festival builder's first screen.
 *
 * The point of these assertions is the contract with the API, not the layout:
 * occasions and templates come from the server, and the price shown before the
 * button is enabled is the server's quote. A client-side price would be the one
 * thing a user could reasonably sue over.
 */

const OCCASIONS = [{ id: 'DIWALI', displayName: 'Diwali', iconUrl: null }];

const TEMPLATE = {
  id: 'diwali-glow-v1',
  occasionId: 'DIWALI',
  name: 'Diwali Glow',
  previewUrl: 'templates/diwali-glow-v1/preview.png',
  colorScheme: { primary: '#FF9933', accent: '#FFD700', background: '#1A1A2E' },
  dimensions: { width: 1080, height: 1080 },
  reelDurationSeconds: 15,
};

const ESTIMATE = { poster: 6, reelAddOn: 0, total: 6, includeReel: false };

describe('FestivalStudio', () => {
  it('loads the catalogue and shows the server quote before generating', async () => {
    const { client, calls } = stubApi({
      'GET /festival/occasions': { body: OCCASIONS },
      'GET /festival/templates': { body: [TEMPLATE] },
      'GET /festival/estimate': { body: ESTIMATE },
      'GET /credits': { body: { wallet: { available: 50, reserved: 0 } } },
    });

    renderWithProviders(<FestivalStudio campaignId="c1" />, client);

    expect(await screen.findByRole('heading', { name: 'Festival campaign' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Diwali (selected)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      await screen.findByRole('button', { name: 'Diwali Glow template (selected)' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/This will use 6 credits/)).toBeInTheDocument();
    expect(await screen.findByText(/Your balance: 50 credits/)).toBeInTheDocument();

    // The quote was requested from the server, not computed in the client.
    expect(calls.some((call) => call.url.startsWith('/festival/estimate'))).toBe(true);
    expect(calls.some((call) => call.url.includes('includeReel=false'))).toBe(true);
  });

  it('asks for a reel-inclusive quote when the reel option is toggled', async () => {
    const { client, calls } = stubApi({
      'GET /festival/occasions': { body: OCCASIONS },
      'GET /festival/templates': { body: [TEMPLATE] },
      'GET /festival/estimate': { body: ESTIMATE },
      'GET /credits': { body: { wallet: { available: 50, reserved: 0 } } },
    });

    renderWithProviders(<FestivalStudio campaignId="c1" />, client);

    const reel = await screen.findByRole('checkbox', { name: /Include a 15-second reel/i });
    await userEvent.click(reel);

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('includeReel=true'))).toBe(true);
    });
  });

  it('does not enable generation until the offer and CTA are present', async () => {
    const { client } = stubApi({
      'GET /festival/occasions': { body: OCCASIONS },
      'GET /festival/templates': { body: [TEMPLATE] },
      'GET /festival/estimate': { body: ESTIMATE },
      'GET /credits': { body: { wallet: { available: 50, reserved: 0 } } },
    });

    renderWithProviders(<FestivalStudio campaignId="c1" />, client);

    const generate = await screen.findByRole('button', { name: /Generate festival post/i });
    expect(generate).toBeDisabled();

    await userEvent.type(
      await screen.findByLabelText('Offer'),
      '20% off every box of mithai this Diwali',
    );
    await userEvent.type(await screen.findByLabelText('Call to action'), 'Order before Friday');

    await waitFor(() => expect(generate).toBeEnabled());
  });
});
