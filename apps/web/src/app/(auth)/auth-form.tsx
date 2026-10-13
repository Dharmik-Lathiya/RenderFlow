'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../lib/providers';
import { Button, Card, ErrorNotice, Field } from '../../components/ui';
import styles from '../../components/ui.module.css';

/**
 * Sign in and sign up.
 *
 * One component with a `mode` prop rather than two pages: the fields, the
 * validation and the error handling are identical, and the only thing that
 * differs is the endpoint and one word of copy. Two copies of a login form is
 * two places for them to drift.
 *
 * Validation happens on blur and on submit, never on every keystroke. A field
 * that shouts "invalid" while someone is still typing their email teaches them
 * to ignore the only signal that matters.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const api = useApi();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });

  const mutation = useMutation({
    mutationFn: async () => {
      const body = { email: email.trim(), password };

      return mode === 'register' ? api.auth.register(body) : api.auth.login(body);
    },
    // A full navigation, not a client-side push: the session is an httpOnly
    // cookie the server has to see, and a client-side route would render the
    // dashboard before the cookie was visible to any server component.
    onSuccess: () => {
      window.location.href = '/';
    },
  });

  const emailError = touched.email ? validateEmail(email) : undefined;
  const passwordError = touched.password ? validatePassword(password, mode) : undefined;

  const submitting = mutation.isPending;

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setTouched({ email: true, password: true });

    if (validateEmail(email) !== undefined || validatePassword(password, mode) !== undefined) {
      return;
    }

    mutation.mutate();
  }

  return (
    <div className={styles.authCard}>
      <Card
        title={mode === 'register' ? 'Create your account' : 'Sign in'}
        description={
          mode === 'register' ? 'Every new account starts with 50 free credits.' : 'Welcome back.'
        }
      >
        <form className={styles.authForm} onSubmit={onSubmit} noValidate>
          {mutation.isError && <ErrorNotice message={messageFor(mutation.error, mode)} />}

          <Field label="Email" id="email" error={emailError}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => setTouched((state) => ({ ...state, email: true }))}
              />
            )}
          </Field>

          <Field
            label="Password"
            id="password"
            error={passwordError}
            hint={mode === 'register' ? 'At least 8 characters.' : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onBlur={() => setTouched((state) => ({ ...state, password: true }))}
              />
            )}
          </Field>

          <Button type="submit" variant="primary" busy={submitting}>
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/**
 * What the user is told when the API refuses.
 *
 * The server's message is used where it is safe and specific, because "Invalid
 * email or password" beats "something went wrong". A 500 gets a generic
 * message instead: the server's text for an internal error is written for an
 * operator, not for someone who just typed their password.
 */
function messageFor(error: unknown, mode: 'login' | 'register'): string {
  if (!(error instanceof ApiClientError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  if (error.status >= 500) {
    return 'The server had a problem. Nothing was charged; try again in a moment.';
  }

  if (error.code === 'EMAIL_ALREADY_REGISTERED') {
    return 'That email is already registered. Sign in instead.';
  }

  if (error.code === 'INVALID_CREDENTIALS') {
    return 'That email and password do not match.';
  }

  if (error.code === 'VALIDATION_FAILED') {
    return error.message;
  }

  return mode === 'register' ? 'Could not create the account.' : 'Could not sign in.';
}

function validateEmail(value: string): string | undefined {
  if (value.trim() === '') {
    return 'Enter your email address.';
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) {
    return 'That does not look like an email address.';
  }

  return undefined;
}

function validatePassword(value: string, mode: 'login' | 'register'): string | undefined {
  if (value === '') {
    return 'Enter your password.';
  }

  if (mode === 'register' && value.length < 8) {
    return 'Use at least 8 characters.';
  }

  return undefined;
}
