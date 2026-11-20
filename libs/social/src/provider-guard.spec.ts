import { AppError, ERROR_CODES } from '@renderflow/common';

import { MockSocialAdapter } from './mock-adapter';
import { adapterFor, assertSocialPublishProviderIsSafe } from './runtime';

describe('adapterFor', () => {
  it('builds the deterministic mock by default', () => {
    expect(adapterFor('linkedin')).toBeInstanceOf(MockSocialAdapter);
  });

  it('passes token-expiry injection through to the mock', async () => {
    const adapter = adapterFor('instagram', { tokenExpired: true });
    await expect(adapter.publish({ idempotencyKey: 'k1', content: 'hello' })).rejects.toMatchObject(
      { classification: 'AUTH_EXPIRED' },
    );
  });

  it('refuses a real adapter instead of silently returning a mock', () => {
    try {
      adapterFor('linkedin', { mock: false });
      throw new Error('expected the factory to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
      expect((error as AppError).message).toMatch(/linkedin publish adapter is not implemented/);
    }
  });
});

describe('assertSocialPublishProviderIsSafe', () => {
  it('allows mocks outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() => assertSocialPublishProviderIsSafe({ nodeEnv, mode: 'mock' })).not.toThrow();
    }
  });

  it('refuses an unset mode in production', () => {
    expect(() =>
      assertSocialPublishProviderIsSafe({ nodeEnv: 'production', mode: undefined }),
    ).toThrow(/SOCIAL_PROVIDER=unset/);
  });

  it('refuses an explicit mock in production', () => {
    expect(() =>
      assertSocialPublishProviderIsSafe({ nodeEnv: 'production', mode: 'mock' }),
    ).toThrow(/SOCIAL_PROVIDER=mock/);
  });

  it('refuses real mode because no publish adapter is implemented', () => {
    expect(() =>
      assertSocialPublishProviderIsSafe({ nodeEnv: 'development', mode: 'real' }),
    ).toThrow(/no real social publish adapter is implemented/);
    expect(() =>
      assertSocialPublishProviderIsSafe({ nodeEnv: 'production', mode: 'real' }),
    ).toThrow(/no real social publish adapter is implemented/);
  });
});
