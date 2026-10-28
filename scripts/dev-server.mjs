#!/usr/bin/env node
/**
 * Starts one app in watch mode on whatever Node the developer actually has.
 *
 * Every app used to run this command line directly:
 *
 *     node --no-experimental-strip-types --watch -r ts-node/register/transpile-only src/main.ts
 *
 * `--no-experimental-strip-types` only exists from Node 22.6, where it stops
 * Node's built-in TypeScript stripping from competing with ts-node's require
 * hook. On Node 20 the same line is not a fallback, it is a hard failure:
 * `node: bad option: --no-experimental-strip-types`, exit code 9, and because
 * `pnpm dev` starts every app at once, all six workers and the API die together
 * before printing anything useful.
 *
 * Passing the flag only where the runtime understands it keeps the supported
 * Node 22+ behaviour exactly as it was, and lets an older runtime start instead
 * of killing `pnpm dev` outright. The engines field still says which versions
 * are supported; this only removes a misleading error from the unsupported one.
 *
 * Usage (from an app directory): node ../../scripts/dev-server.mjs src/main.ts
 */
import { spawn } from 'node:child_process';

/** First Node version that accepts `--no-experimental-strip-types`. */
export const STRIP_TYPES_FLAG_FROM = { major: 22, minor: 6 };

/**
 * The argument list for one app, given the running Node version.
 *
 * Exported so the version comparison is a pure function of its input rather
 * than something that can only be observed by spawning a process.
 *
 * @param {string} nodeVersion e.g. `process.versions.node`
 * @param {string} entry module to run, e.g. `src/main.ts`
 * @returns {string[]}
 */
export function devArgs(nodeVersion, entry) {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const supportsFlag =
    major > STRIP_TYPES_FLAG_FROM.major ||
    (major === STRIP_TYPES_FLAG_FROM.major && minor >= STRIP_TYPES_FLAG_FROM.minor);

  return [
    ...(supportsFlag ? ['--no-experimental-strip-types'] : []),
    '--watch',
    '-r',
    'ts-node/register/transpile-only',
    entry,
  ];
}

const entry = process.argv[2];

if (entry === undefined) {
  console.error('usage: node scripts/dev-server.mjs <entry.ts>');
  process.exit(2);
}

const child = spawn(process.execPath, devArgs(process.versions.node, entry), {
  stdio: 'inherit',
});

// Forward termination so a worker's SIGTERM handler still runs when `pnpm dev`
// is stopped. Plain Ctrl+C already reaches the whole process group, but a
// supervisor that signals only this wrapper would otherwise orphan the app.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`failed to start ${entry}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // A signal is how a watcher is expected to end; do not report it as a failure.
  process.exit(code ?? (signal === null ? 1 : 0));
});
