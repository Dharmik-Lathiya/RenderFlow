import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ValidationFailedError } from '@renderflow/common';
import { z } from 'zod';

import { CurrentUser, Public, type AuthenticatedUser } from '../auth/auth.guard';
import { NeonService, type NeonStatus } from './neon.service';

const verifySchema = z.object({ token: z.string().min(1).max(8_192) });

/** Public status only; it carries URLs and booleans, never credentials. */
@ApiTags('neon')
@Controller('neon')
export class NeonController {
  constructor(private readonly neon: NeonService) {}

  @Get('status')
  @Public()
  @ApiOperation({ summary: 'Neon service wiring and reachability' })
  async status(): Promise<NeonStatus> {
    return this.neon.status();
  }

  @Post('auth/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a Neon Managed Auth JWT' })
  async verify(
    @Body() body: unknown,
  ): Promise<{ ok: true; subject: string; email: string | null }> {
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(parsed.error.flatten());
    }
    const identity = await this.neon.verifyAuthToken(parsed.data.token);
    return { ok: true, ...identity };
  }

  @Get('gateway/models')
  @Public()
  @ApiOperation({ summary: 'List models available through the Neon AI Gateway' })
  async models(): Promise<{ ok: boolean; modelCount: number | null; error?: string }> {
    return this.neon.gatewayProbe();
  }

  @Get('function/hello')
  @ApiOperation({ summary: 'Invoke the deployed Neon Function' })
  async hello(): Promise<{ ok: boolean; status: number; body: string }> {
    return this.neon.callHelloFunction();
  }

  @Post('realtime/job/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Seal a workspace-scoped live query for job checkpoints' })
  async sealJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('jobId') jobId: string,
  ): Promise<{ sealed: Awaited<ReturnType<NeonService['sealJobCheckpoints']>> }> {
    const sealed = await this.neon.sealJobCheckpoints(user.id, jobId);
    return { sealed };
  }
}
