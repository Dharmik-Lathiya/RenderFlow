/**
 * Dumps the OpenAPI document to `openapi.json`.
 *
 * The api-client is GENERATED from this file (AGENTS.md section 3:
 * `packages/api-client` is generated from the API OpenAPI document; never
 * hand-edit it). Generation needs a fully-wired Nest application, which cannot
 * be built inside a plain node script, so this runs inside the API's own
 * process bootstrap instead.
 *
 *   node apps/api/dist/openapi-dump.js        # after `pnpm build`
 *   pnpm openapi:generate                    # the real entry point
 *
 * Output is deterministic (keys sorted, no timestamps) so the committed file
 * only changes when the API's contract does. A diff that changes only ordering
 * is noise; a diff that changes a path is a reviewable contract change.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { buildOpenApiDocument } from './common/openapi';

/** Everything the document needs, and nothing that connects to anything. */
async function main(): Promise<void> {
  // `abortOnError: false` is essential and easy to miss: NestFactory's default is
  // to call `process.exit(1)` on a bootstrap failure, which means the process
  // dies with NO output and the catch below never runs. A generator that dies
  // silently teaches people to re-run it with a flag instead of reading it.
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  try {
    // No global pipes: this app validates with zod at the controller, not with
    // Nest's `ValidationPipe`, so adding one here would pull in class-validator
    // for no reason - and fail to boot without it.
    //
    // `init()` wires every controller's routes, which is what SwaggerModule
    // introspects. Building the document without it yields an empty one.
    await app.init();

    const document = buildOpenApiDocument(app) as unknown as Record<string, unknown>;
    const sorted = sortKeys(document);

    // `__dirname`, not `import.meta.url`: this app compiles to CommonJS
    // (tsconfig.base.json), where `import.meta` does not exist. The compiled
    // file lives at apps/api/dist/, so the repo root is three levels up - and
    // getting this wrong writes to apps/packages/ instead of failing, which is
    // exactly what happened the first time.
    const out = join(__dirname, '..', '..', '..', 'packages', 'api-client', 'openapi.json');

    writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    process.stdout.write(`wrote ${out}\n`);
  } finally {
    await app.close();
  }
}

/** Recursively sorts object keys so the output is byte-stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }

  return value;
}

void main().catch((error: unknown) => {
  // `void main()` alone exits 1 with NO output on a rejected promise, which
  // makes a missing environment variable indistinguishable from a crash in the
  // dump. A generator that fails silently is a generator nobody trusts.
  process.stderr.write(`openapi-dump failed: ${describe(error)}\n`);
  process.exitCode = 1;
});

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
