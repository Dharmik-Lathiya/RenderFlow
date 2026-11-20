import { ERROR_CODES } from '../errors/error-codes';
import { AppError } from '../errors/app-error';

import {
  assertNoMockProviderInProduction,
  isMockProviderMode,
  providerConfigurationError,
} from './provider-mode';

describe('isMockProviderMode', () => {
  it('treats unset and mock as mock modes', () => {
    expect(isMockProviderMode(undefined)).toBe(true);
    expect(isMockProviderMode('')).toBe(true);
    expect(isMockProviderMode(' mock ')).toBe(true);
    expect(isMockProviderMode('MOCK')).toBe(true);
  });

  it('treats a named real provider as real', () => {
    expect(isMockProviderMode('openai')).toBe(false);
    expect(isMockProviderMode('real')).toBe(false);
  });
});

describe('assertNoMockProviderInProduction', () => {
  it('allows mocks outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() =>
        assertNoMockProviderInProduction({ nodeEnv, variable: 'AI_PROVIDER', mode: 'mock' }),
      ).not.toThrow();
    }
  });

  it('allows an explicit real provider in production', () => {
    expect(() =>
      assertNoMockProviderInProduction({
        nodeEnv: 'production',
        variable: 'AI_PROVIDER',
        mode: 'anthropic',
      }),
    ).not.toThrow();
  });

  it('refuses an unset variable in production', () => {
    expect(() =>
      assertNoMockProviderInProduction({
        nodeEnv: 'production',
        variable: 'SOCIAL_PROVIDER',
        mode: undefined,
      }),
    ).toThrow(/SOCIAL_PROVIDER=unset/);
  });

  it('refuses an explicit mock provider in production with a stable code', () => {
    try {
      assertNoMockProviderInProduction({
        nodeEnv: 'production',
        variable: 'IMAGE_PROVIDER',
        mode: 'mock',
        details: { configuredValue: 'bogus' },
      });
      throw new Error('expected the guard to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
      expect((error as AppError).toBody().details).toEqual({
        variable: 'IMAGE_PROVIDER',
        mode: 'mock',
        configuredValue: 'bogus',
      });
    }
  });
});

describe('providerConfigurationError', () => {
  it('uses the shared provider error code', () => {
    const error = providerConfigurationError('real adapter unavailable', { platform: 'linkedin' });
    expect(error.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
    expect(error.toBody().details).toEqual({ platform: 'linkedin' });
  });
});
