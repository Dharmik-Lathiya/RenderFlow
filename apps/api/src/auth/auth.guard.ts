import {
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AppError, ERROR_CODES, type UserRole } from '@renderflow/common';

import { ACCESS_TOKEN_COOKIE, loadAuthConfigFrom, type AuthConfig } from './auth.config';
import type { Env } from '../config/env';
import type { RequestWithAuth } from './request.types';
import { verifyAccessToken } from './token.service';

/** Identity attached to a request by AuthGuard. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

// `user` is set by AuthGuard after cookie parsing, so it is widened onto the
// Express request type for the duration of the request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      cookies?: Record<string, string>;
    }
  }
}

/**
 * Endpoint marker: `@Public()` opts a route out of authentication.
 *
 * Health, metrics and the auth endpoints themselves are public; everything else
 * is denied by default (PROJECT.md section 15).
 */
export const IS_PUBLIC_KEY = 'renderflow:isPublic';
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'renderflow:roles';
export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Requires a valid access token.
 *
 * Accepts it from the httpOnly cookie (web) or an `Authorization: Bearer` header
 * (mobile / CLI). A header takes precedence when both are present, so an explicit
 * credential is never silently overridden by a stale cookie.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private config!: AuthConfig;

  constructor(
    private readonly reflector: Reflector,
    configService: ConfigService<Env, true>,
  ) {
    this.config = loadAuthConfigFrom(configService);
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = extractAccessToken(request);

    if (token === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Authentication required');
    }

    const claims = verifyAccessToken(token, this.config.JWT_ACCESS_SECRET);
    request.user = { id: claims.sub, role: claims.role as UserRole };

    return true;
  }
}

/** Reads the token from the header first, then the httpOnly cookie. */
export function extractAccessToken(request: RequestWithAuth): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value !== '') {
      return value;
    }
  }

  const cookie = (request.cookies as Record<string, string> | undefined)?.[ACCESS_TOKEN_COOKIE];
  return cookie !== undefined && cookie !== '' ? cookie : null;
}

/**
 * Role gate. Requires `AuthGuard` first: `@UseGuards(AuthGuard, RolesGuard)`
 * or the global guard chain configured in app.module.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const user = request.user;

    if (user === undefined) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Authentication required');
    }

    if (!required.includes(user.role)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Insufficient role', {
        details: { required, actual: user.role },
      });
    }

    return true;
  }
}

/** Injects the authenticated user into a handler parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (request.user === undefined) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Authentication required');
    }
    return request.user;
  },
);
