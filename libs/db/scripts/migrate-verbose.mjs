import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Drizzle Kit 0.31 swallows migration errors behind its spinner. This runner
 * uses the same migrator but prints the full error so deployment failures can
 * be diagnosed without a paid Render Shell.
 */
function formatError(error, seen = new Set()) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const base = error.stack ?? error.message;
  if (!('cause' in error) || error.cause === undefined || seen.has(error.cause)) {
    return base;
  }

  seen.add(error.cause);
  return `${base}\nCaused by: ${formatError(error.cause, seen)}`;
}

function connectionOptions(url) {
  const parsed = new URL(url);
  const sslMode = parsed.searchParams.get('sslmode');
  const localHost =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';

  // pg-connection-string warns on `require`; verify-full is its strict alias.
  if (sslMode === 'require') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }

  // Hosted Postgres (Render included) may require TLS even when the pasted URL
  // has no sslmode. Local Compose must stay plaintext.
  const useSsl = localHost ? false : sslMode !== 'disable';
  return {
    connectionString: parsed.toString(),
    ssl: useSsl ? { rejectUnauthorized: true } : undefined,
  };
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL (or DATABASE_URL_UNPOOLED) is required\n');
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const pool = new Pool({
  ...connectionOptions(url),
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  await migrate(drizzle(pool), { migrationsFolder });
  process.stderr.write('migrations applied successfully\n');
} catch (error) {
  process.stderr.write(`migration failed: ${formatError(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
