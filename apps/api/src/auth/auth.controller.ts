import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { UserRole } from '@renderflow/common';
import { z } from 'zod';

import { ValidationFailedError } from '@renderflow/common';

import { RATE_LIMIT_RULES, RateLimit } from '../ratelimit/rate-limit.guard';
import { CSRF_COOKIE, REFRESH_TOKEN_COOKIE } from './auth.config';
import { loginSchema, registerSchema, type AuthResponse, type RegisterDto } from './auth.dto';
import { AuthService, type IssuedSession, type SessionMetadata } from './auth.service';
import { CurrentUser, Public, type AuthenticatedUser } from './auth.guard';
import {
  clientIp,
  clientUserAgent,
  type CookieSerializeOptions,
  type RequestWithAuth,
  type ResponseWithCookies,
} from './request.types';

/**
 * Auth routes.
 *
 * All `@Public()` because there is no session yet. CSRF still applies to
 * `refresh` and `logout`, which are state-changing; only login/register are
 * exempt (see CsrfGuard).
 *
 * Every endpoint that can be reached without a session is rate limited, keyed
 * on the source IP. Login additionally gets a per-submitted-email limit:
 * IP-only would not slow a credential-stuffing run spread across many hosts but
 * aimed at one account. See `rate-limit.config.ts` for why that second limit is
 * deliberately generous.
 */
@ApiTags('auth')
@Controller('auth')
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /api/v1/auth/register - creates the user and grants the signup bonus. */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account and grant the signup bonus' })
  // Tightest limit here: each accepted call mints a user AND grants credits, so
  // unbounded registration is both an abuse vector and a way to drain the bonus
  // pool across throwaway accounts.
  @RateLimit({ name: RATE_LIMIT_RULES.REGISTER_IP, scope: 'ip' })
  async register(
    @Body() body: unknown,
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: ResponseWithCookies,
  ): Promise<AuthResponse> {
    const dto: RegisterDto = parseBody(registerSchema, body);
    const session = await this.auth.register(
      { email: dto.email, password: dto.password, name: dto.name },
      sessionMeta(request),
    );
    applySessionCookies(response, session);
    return toResponse(session);
  }

  /** POST /api/v1/auth/login */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for a session' })
  @RateLimit(
    { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' },
    // Second, independent limit keyed on the submitted address, so the pair
    // stops both a single-host flood and a distributed attack on one account.
    { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' },
  )
  async login(
    @Body() body: unknown,
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: ResponseWithCookies,
  ): Promise<AuthResponse> {
    const dto = parseBody(loginSchema, body);
    const session = await this.auth.login(dto.email, dto.password, sessionMeta(request));
    applySessionCookies(response, session);
    return toResponse(session);
  }

  /** POST /api/v1/auth/refresh - rotates the refresh token. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  @RateLimit({ name: RATE_LIMIT_RULES.REFRESH_IP, scope: 'ip' })
  async refresh(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: ResponseWithCookies,
  ): Promise<AuthResponse> {
    const session = await this.auth.refresh(readRefreshCookie(request), sessionMeta(request));
    applySessionCookies(response, session);
    return toResponse(session);
  }

  /** POST /api/v1/auth/logout - revokes the session and clears cookies. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the presented session' })
  async logout(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: ResponseWithCookies,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(request));
    clearSessionCookies(response);
  }

  /** GET /api/v1/auth/me - the token's claims; GET /me returns the full profile. */
  @Get('me')
  @ApiOperation({ summary: "The current token's claims" })
  me(@CurrentUser() user: AuthenticatedUser): { id: string; role: UserRole } {
    return { id: user.id, role: user.role };
  }
}

/**
 * Parses with zod and raises the shared validation error, so the global
 * exception filter produces the documented `{ code, message, details }` body.
 */
function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationFailedError(formatIssues(result.error));
  }
  return result.data;
}

/** Flattens zod's issue tree into `{ field: [messages] }`. */
function formatIssues(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
    details[field] = [...(details[field] ?? []), issue.message];
  }
  return details;
}

function sessionMeta(request: RequestWithAuth): SessionMetadata {
  return { userAgent: clientUserAgent(request), ipAddress: clientIp(request) };
}

function readRefreshCookie(request: RequestWithAuth): string {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[REFRESH_TOKEN_COOKIE];
  if (typeof token !== 'string' || token === '') {
    throw new ValidationFailedError({
      [REFRESH_TOKEN_COOKIE]: ['Refresh token cookie is missing'],
    });
  }
  return token;
}

/**
 * Cookie policy (AGENTS.md section 10):
 *   - tokens httpOnly, so script cannot read them;
 *   - `SameSite=Lax`, so they are not attached to cross-site POSTs;
 *   - `Secure` in production;
 *   - CSRF cookie deliberately readable, because the client must echo it.
 */
function applySessionCookies(response: ResponseWithCookies, session: IssuedSession): void {
  const secure = process.env.NODE_ENV === 'production';
  const common: CookieSerializeOptions = { secure, sameSite: 'lax', path: '/' };

  response.cookie('rf_access', session.accessToken, {
    ...common,
    httpOnly: true,
    maxAge: ms(session.accessTokenExpiresInSeconds),
  });

  response.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
    ...common,
    httpOnly: true,
    maxAge: ms(Math.floor((session.refreshTokenExpiresAt.getTime() - Date.now()) / 1000)),
  });

  response.cookie(CSRF_COOKIE, session.csrfToken, {
    ...common,
    httpOnly: false,
    maxAge: ms(session.accessTokenExpiresInSeconds),
  });
}

/**
 * Express expects `maxAge` in MILLISECONDS and derives both `Expires` and
 * `Max-Age` from it. The API models token lifetimes in seconds, so they must be
 * converted here: passing seconds straight through yields `Max-Age=900` for a
 * 15-minute token, which the browser treats as 15 *seconds* and discards
 * immediately - logging the user out on the very next request.
 */
function ms(seconds: number): number {
  return Math.max(0, Math.floor(seconds)) * 1000;
}

function clearSessionCookies(response: ResponseWithCookies): void {
  const secure = process.env.NODE_ENV === 'production';
  for (const name of ['rf_access', REFRESH_TOKEN_COOKIE, CSRF_COOKIE]) {
    response.clearCookie(name, {
      secure,
      sameSite: 'lax',
      path: '/',
      httpOnly: name !== CSRF_COOKIE,
    });
  }
}

/**
 * The refresh token travels only in the httpOnly cookie. `accessToken` is in the
 * body so a mobile client can store it in a secure token store instead.
 */
function toResponse(session: IssuedSession): AuthResponse {
  return {
    user: session.user,
    accessToken: session.accessToken,
    accessTokenExpiresInSeconds: session.accessTokenExpiresInSeconds,
    csrfToken: session.csrfToken,
  };
}
