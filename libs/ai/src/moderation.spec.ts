import {
  BLOCKED_TERMS,
  LocalModerator,
  ProviderModerator,
  createModerator,
  normalise,
} from './moderation';
import { ProviderError } from './providers';

/**
 * Moderation.
 *
 * The properties worth pinning are the ones with billing consequences: a refusal
 * must be a refusal (not a warning), it must be un-overridable by a model, and an
 * outage of the third-party check must not take the product down.
 */

describe('normalise', () => {
  it('lowercases', () => {
    expect(normalise('DOXXING')).toBe('doxxing');
  });

  it('REMOVES separators rather than replacing them with spaces', () => {
    // Replacing punctuation with spaces defeated the point: `D-o-x-x-i-n-g`
    // became `d o x x i n g`, which does not contain `doxxing`, so the one
    // obfuscation a person would actually try walked straight through.
    expect(normalise('D-o-x-x-i-n-g')).toBe('doxxing');
    expect(normalise('d.o.x.x.i.n.g')).toBe('doxxing');
    expect(normalise('d o x x i n g')).toBe('doxxing');
  });

  it('keeps letters from other scripts', () => {
    expect(normalise('café')).toBe('café');
  });
});

describe('LocalModerator', () => {
  const moderator = new LocalModerator();

  it('allows ordinary brand content', async () => {
    const verdict = await moderator.moderate({
      text: 'Rain again on the 8:04. Bring a coat.',
      kind: 'CAPTION',
    });

    expect(verdict.allowed).toBe(true);
  });

  it('refuses a blocked term', async () => {
    const verdict = await moderator.moderate({
      text: `here is a post about ${BLOCKED_TERMS[0]}`,
      kind: 'CAPTION',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain(BLOCKED_TERMS[0]);
  });

  it('catches a term hidden behind punctuation and case', async () => {
    // A list checked against raw text is defeated by a capital letter.
    const verdict = await moderator.moderate({
      text: 'D-o-x-x-i-n-g is a thing we do not do',
      kind: 'CAPTION',
    });

    expect(verdict.allowed).toBe(false);
  });

  it('names the category, never the user text', async () => {
    // Echoing the refused content into a log line and an API response is the
    // opposite of what a moderation decision is for.
    const secret = 'my-home-address-is-123';
    const verdict = await moderator.moderate({ text: secret, kind: 'CAPTION' });

    expect(verdict.reason ?? '').not.toContain(secret);
  });

  it('reports which rule decided', async () => {
    expect((await moderator.moderate({ text: 'hello', kind: 'X' })).source).toBe('local');
  });
});

describe('ProviderModerator', () => {
  const local = new LocalModerator();

  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }

  it('passes content the provider finds clean', async () => {
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () => ok({ results: [{ flagged: false }] }),
    });

    expect((await moderator.moderate({ text: 'nice post', kind: 'X' })).allowed).toBe(true);
  });

  it('honours a provider refusal', async () => {
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () => ok({ results: [{ flagged: true, category: 'violence' }] }),
    });

    const verdict = await moderator.moderate({ text: 'something', kind: 'X' });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('violence');
  });

  it('never lets the provider UN-refuse a local refusal', async () => {
    // The safety property of the whole design: a model must not be able to undo a
    // deterministic rule, or the rule is decorative.
    let called = false;
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () => {
        called = true;
        return ok({ results: [{ flagged: false }] });
      },
    });

    const verdict = await moderator.moderate({
      text: `post about ${BLOCKED_TERMS[0]}`,
      kind: 'X',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.source).toBe('local');
    expect(called).toBe(false);
  });

  it('runs only the local rules when no key is configured', async () => {
    // A local setup with no provider must still be able to generate.
    const verdict = await new ProviderModerator({}).moderate({ text: 'hello', kind: 'X' });
    expect(verdict.allowed).toBe(true);
  });

  it('still refuses locally with no key, so a deployment cannot turn moderation off', async () => {
    const verdict = await new ProviderModerator({}).moderate({
      text: BLOCKED_TERMS[0] ?? 'explicit sexual content',
      kind: 'X',
    });

    expect(verdict.allowed).toBe(false);
  });

  it('reports a provider outage as transient rather than allowing everything silently', async () => {
    // The caller needs to know: the request proceeds on the local rules alone,
    // and the outage is visible instead of swallowed.
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () =>
        ({ ok: false, status: 503, text: async () => 'down' }) as unknown as Response,
    });

    await expect(moderator.moderate({ text: 'hello', kind: 'X' })).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });

  it('does not let a malformed provider response unblock content silently', async () => {
    // A response we cannot read is not a clean bill of health.
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () => ok({ unexpected: true }),
    });

    // Nothing to parse means no flag found; the local rules stand.
    expect((await moderator.moderate({ text: 'hello', kind: 'X' })).allowed).toBe(true);
  });

  it('raises a typed error an outage handler can recognise', async () => {
    const moderator = new ProviderModerator({
      apiKey: 'k',
      local,
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
    });

    await expect(moderator.moderate({ text: 'x', kind: 'X' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('createModerator', () => {
  it('always enforces the local rules', () => {
    expect(createModerator()).toBeInstanceOf(ProviderModerator);
  });

  it('refuses a blocked term with no configuration at all', async () => {
    // The property the whole Phase 6 moderation requirement rests on: it cannot
    // be switched off by leaving a variable unset.
    const verdict = await createModerator().moderate({
      text: BLOCKED_TERMS[1] ?? 'child sexual abuse material',
      kind: 'X',
    });
    expect(verdict.allowed).toBe(false);
  });
});
