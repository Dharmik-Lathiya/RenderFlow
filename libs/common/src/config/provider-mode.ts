import { ERROR_CODES, type ErrorCode } from '../errors/error-codes';
import { AppError } from '../errors/app-error';

/**
 * Whether a configured provider mode means "deterministic mock".
 *
 * An unset value counts as a mock because every provider factory defaults to its
 * mock implementation. That default is correct for local development and CI, and
 * dangerous in production - so the same rule is used by the boot guards.
 */
export function isMockProviderMode(mode: string | undefined): boolean {
  const normalized = (mode ?? '').trim().toLowerCase();
  return normalized === '' || normalized === 'mock';
}

export interface ProviderModeAssertionOptions {
  nodeEnv: string;
  /** Name of the environment variable the operator has to change. */
  variable: string;
  /** Configured value; `undefined` means the variable was not set. */
  mode: string | undefined;
  /** Additional client-safe context, e.g. a derived provider preference chain. */
  details?: Record<string, unknown>;
}

/**
 * Refuses a mock provider in production.
 *
 * Mocks are deterministic and fast, which makes them the right default for tests.
 * In production they are a silent correctness failure: generated content is a
 * placeholder, social posts are never sent, and credits are still charged. Failing
 * at boot turns that into an immediately visible configuration error.
 */
export function assertNoMockProviderInProduction(options: ProviderModeAssertionOptions): void {
  if (options.nodeEnv !== 'production' || !isMockProviderMode(options.mode)) {
    return;
  }

  const configured =
    options.mode === undefined || options.mode.trim() === '' ? 'unset' : options.mode;

  throw new AppError(
    ERROR_CODES.PROVIDER_UNAVAILABLE,
    `${options.variable}=${configured} selects a mock provider and is refused in production. ` +
      `Configure a real provider before deployment.`,
    {
      details: {
        variable: options.variable,
        mode: options.mode ?? null,
        ...options.details,
      },
    },
  );
}

/** Exposed so typed provider guards can reuse the same stable error shape. */
export function providerConfigurationError(
  message: string,
  details: Record<string, unknown>,
): AppError {
  const code: ErrorCode = ERROR_CODES.PROVIDER_UNAVAILABLE;
  return new AppError(code, message, { details });
}
