import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationFailedError } from '@renderflow/common';
import type { Response } from 'express';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { JobsService, generateSchema } from './jobs.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/** How often the SSE endpoint re-reads progress. */
const SSE_POLL_MS = 250;
/** Safety net so a wedged job cannot hold a connection open forever. */
const SSE_MAX_MS = 120_000;

@ApiTags('jobs')
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('posts/:postId/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create a generation job; reserves credits in the same transaction',
  })
  async generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', uuidParam) postId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.length > 0 ? issue.path.join('.') : '(body)',
            issue.message,
          ]),
        ),
      );
    }

    // 202 rather than 201: the work has not happened yet, and nothing has been
    // created synchronously that the caller could wait for.
    return this.jobs.generate(user.id, postId, parsed.data, idempotencyKey);
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Job status and completed stages' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('jobId', uuidParam) jobId: string) {
    return this.jobs.get(user.id, jobId);
  }

  /**
   * Live progress.
   *
   * Polls the durable record (`job_checkpoints`) rather than subscribing to an
   * in-process bus, so it survives an API restart and works across instances:
   * the checkpoints are the truth, and a client that reconnects gets the full
   * history rather than only what it happened to be connected for.
   */
  @Get('jobs/:jobId/events')
  @ApiOperation({ summary: 'Server-sent progress events for a job' })
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('jobId', uuidParam) jobId: string,
    @Res() response: Response,
  ): Promise<void> {
    // Authorise BEFORE writing any bytes, so a caller who may not see the job
    // gets a normal 403 rather than a 200 stream of errors.
    await this.jobs.progress(user.id, jobId);

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastFingerprint = '';
    const deadline = Date.now() + SSE_MAX_MS;

    const tick = async (): Promise<void> => {
      // Client disconnect is the normal end of an SSE stream, not an error.
      if (response.writableEnded || Date.now() > deadline) {
        send('done', { reason: response.writableEnded ? 'client-closed' : 'timeout' });
        response.end();
        return;
      }

      try {
        const view = await this.jobs.progress(user.id, jobId);
        // Only emit on change: a stream of identical events would be noise, and
        // an idle client should not be paying for a JSON payload every 250 ms.
        const fingerprint = `${view.status}:${view.stage}:${view.completedStages.join(',')}`;

        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          send('progress', view);
        }

        if (await this.jobs.isSettled(jobId)) {
          send('done', { status: view.status });
          response.end();
          return;
        }
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : 'unknown' });
        response.end();
        return;
      }

      setTimeout(() => void tick(), SSE_POLL_MS).unref();
    };

    await tick();
  }
}
