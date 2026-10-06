import { z } from 'zod';

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password';

/**
 * Auth DTOs. Validated with zod at the HTTP edge (AGENTS.md section 7).
 */

/**
 * Emails are compared case-insensitively, so they are normalized to lowercase
 * before validation and before storage. Without this, `A@x.com` and `a@x.com`
 * would be two accounts and the "same email twice" guard would fail.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const emailSchema = z
  .string()
  .trim()
  .min(3)
  // 320 is the RFC 5321 maximum length.
  .max(320)
  .email()
  .transform(normalizeEmail);

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
});

export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export type LoginDto = z.infer<typeof loginSchema>;

/** Response body for register/login/refresh. Never includes the password hash. */
export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  /** Present so non-browser clients (mobile) can use the API without cookies. */
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  /** CSRF token to echo in the `x-csrf-token` header on unsafe requests. */
  csrfToken: string;
}

export const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  createdAt: z.string(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
