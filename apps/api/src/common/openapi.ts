import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

import { Public } from '../auth/auth.guard';

/**
 * OpenAPI document (PROJECT.md section 12 Phase 3 DoD: "OpenAPI docs
 * generated").
 *
 * Served from `/docs-json` (the raw document, which CI diffs against a committed
 * copy as a contract test) and `/docs` (Swagger UI, outside production).
 *
 * A controller rather than a raw Express route, so the endpoint participates in
 * Nest's router and behaves identically in production and under the integration
 * harness.
 *
 * The controller reads a module-level document instead of building its own: the
 * document can only be generated from a fully-wired `INestApplication`, and
 * rebuilding it per request would be wasteful and easy to get subtly different.
 */

export const OPENAPI_JSON_PATH = 'docs-json';

type OpenApiDocument = ReturnType<typeof SwaggerModule.createDocument>;

let document: OpenApiDocument | null = null;

/** Builds the document from a wired application. */
export function buildOpenApiDocument(app: INestApplication): OpenApiDocument {
  const config = new DocumentBuilder()
    .setTitle('RenderFlow API')
    .setDescription(
      'AI marketing studio and scheduler. Auth is cookie-based for the web app ' +
        'and `Authorization: Bearer` for mobile clients.',
    )
    .setVersion('1.0')
    .addCookieAuth('rf_access')
    .addBearerAuth()
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setOpenApiDocument(value: OpenApiDocument): void {
  document = value;
}

/** Test seam: the document is process-global, so a suite must be able to clear it. */
export function resetOpenApiDocument(): void {
  document = null;
}

// Deny-by-default applies here too: without `@Public()` the global AuthGuard
// refuses the document, exactly as it refuses any other undecorated route.
@ApiTags('meta')
@Public()
@Controller()
export class OpenApiController {
  @Get(OPENAPI_JSON_PATH)
  @ApiOperation({ summary: 'The OpenAPI 3 document for this API' })
  current(): unknown {
    if (document === null) {
      // Failing loudly beats serving `{}`, which would look like an API with no
      // routes at all.
      throw new Error('OpenAPI document requested before setupOpenApi() ran');
    }
    return document;
  }
}

/**
 * Wires the document, and the Swagger UI outside production.
 *
 * The UI is omitted in production because it enumerates every route, which is a
 * convenient reconnaissance aid. The JSON stays available everywhere because the
 * contract check depends on it.
 */
export function setupOpenApi(app: INestApplication, options: { mountUi: boolean }): void {
  const built = buildOpenApiDocument(app);
  setOpenApiDocument(built);

  if (options.mountUi) {
    SwaggerModule.setup('docs', app, built);
  }
}

@Module({ controllers: [OpenApiController] })
export class OpenApiModule {}
