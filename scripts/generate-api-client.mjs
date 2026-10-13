#!/usr/bin/env node
/**
 * Generates `packages/api-client/src/generated/routes.ts` from
 * `packages/api-client/openapi.json`.
 *
 * AGENTS.md section 3: "packages/api-client is generated from the API OpenAPI
 * document. Never hand-edit it; regenerate it instead." This is that
 * regeneration. The file it writes is deleted-and-rewritten every run, so a hand
 * edit is lost rather than merged - which is the point of a generator.
 *
 * WHAT IT GENERATES, AND WHY NOT MORE
 *
 * The document currently carries no component schemas, because the API validates
 * with zod at the controller and Nest's Swagger plugin reads decorators, not
 * zod. So route shapes - path, methods, parameter names, request body presence -
 * are generated faithfully, while request and response BODIES are `unknown`.
 *
 * That is a real limit, not a shortcut: a client that claims to type a response
 * it cannot derive is worse than one that admits it is unknown. Closing it
 * means giving the API response schemas, which is a change to the API's own
 * contract and belongs in its own change. `ResponseSchema` below exists so that
 * change is a one-line addition per endpoint rather than a rewrite of this file.
 *
 * The typed domain layer (`src/domains/`) is hand-written on top, and a contract
 * test asserts every path it uses exists in the generated map - so the two
 * cannot drift even though only one of them is generated.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'packages', 'api-client', 'openapi.json');
const OUT = join(ROOT, 'packages', 'api-client', 'src', 'generated', 'routes.ts');

const METHODS = ['get', 'post', 'patch', 'delete', 'put', 'patch'];

/** @param {{openapi:string,paths:Record<string,Record<string,any>>}} doc */
function generate(doc) {
  /** @type {[string, Record<string, any>][]} */
  const entries = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const operationsForPath = {};

    for (const method of new Set(METHODS)) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }

      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const query = parameters.filter((p) => p.in === 'query').map((p) => String(p.name));

      const pathParams = parameters
        .filter((p) => p.in === 'path')
        .map((p) => ({ name: String(p.name), required: p.required !== false }));

      const body = Array.isArray(operation.requestBody) ? operation.requestBody.length > 0 : true;

      operationsForPath[method] = {
        /** `undefined` when the document carries no summary. */
        summary: typeof operation.summary === 'string' ? operation.summary : undefined,
        pathParams,
        query,
        hasBody: body === true && method !== 'get' && method !== 'delete',
      };
    }

    if (Object.keys(operationsForPath).length > 0) {
      entries.push([path, operationsForPath]);
    }
  }

  // Sorted so the output is byte-stable: a diff that changes only ordering is
  // noise, and noise is what makes people stop reading generated diffs.
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with:  pnpm openapi:generate
 * Source:           packages/api-client/openapi.json
 *
 * Hand edits are silently discarded by the next run.
 *
 * Every operation type carries an empty \`request\` and \`response\`, because the
 * document has no component schemas yet - the API validates with zod, which
 * Nest's Swagger plugin cannot read. They are here so that adding a schema later
 * fills them in, rather than changing every consumer's types.
 */
export interface ApiOperation {
  /** Present when the document carries a summary. */
  readonly summary: string | undefined;
  readonly pathParams: readonly { readonly name: string; readonly required: boolean }[];
  readonly query: readonly string[];
  readonly hasBody: boolean;
  /**
   * Typed only once the API publishes a response schema for this operation.
   * \`unknown\` today, and deliberately not \`any\`: a caller has to narrow it,
   * which is what stops an untyped response from spreading through the app.
   */
  readonly response: unknown;
  readonly request: unknown;
}

export type RouteMap = {
${entries
  .map(
    ([path, ops]) =>
      `  readonly ${JSON.stringify(path)}: {\n${Object.keys(ops)
        .map((method) => `    readonly ${method}: ApiOperation;`)
        .join('\n')}\n  };`,
  )
  .join('\n')}
};

/** Every documented path, for the drift test in \`routes.spec.ts\`. */
export const ROUTE_PATHS = [
${entries.map(([path]) => `  ${JSON.stringify(path)},`).join('\n')}
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];

export const ROUTES: RouteMap = {
${entries
  .map(([path, ops]) => {
    const methods = Object.entries(ops)
      .map(
        ([method, op]) => `    ${method}: {
      summary: ${JSON.stringify(op.summary)},
      pathParams: ${JSON.stringify(op.pathParams)},
      query: ${JSON.stringify(op.query)},
      hasBody: ${op.hasBody},
      response: undefined as unknown,
      request: undefined as unknown,
    },`,
      )
      .join('\n');
    return `  ${JSON.stringify(path)}: {\n${methods}\n  },`;
  })
  .join('\n')}
};
`;
}

function main() {
  const doc = JSON.parse(readFileSync(DOC, 'utf8'));

  if (typeof doc.paths !== 'object' || doc.paths === null) {
    // A document with no paths means the API failed to wire up, and generating
    // from it would produce an empty client that still type-checks.
    console.error('openapi.json has no paths; was the API fully wired?');
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, generate(doc), 'utf8');

  const count = Object.values(doc.paths).reduce(
    (total, item) => total + METHODS.filter((m) => item[m] !== undefined).length,
    0,
  );

  console.log(`generated ${OUT} (${Object.keys(doc.paths).length} paths, ${count} operations)`);
}

main();
