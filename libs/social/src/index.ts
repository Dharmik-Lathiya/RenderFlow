/**
 * @renderflow/social
 *
 * Platform adapters, token handling and per-platform formatting rules.
 *
 * `AGENTS.md` section 8 applies here as it does to AI: every adapter sits behind
 * an interface with a deterministic mock, and CI never calls a real platform. A
 * test that depends on LinkedIn accepting a post is a test that fails for reasons
 * unrelated to the code, and one that fails at random teaches people to re-run
 * rather than to read.
 */

export * from './adapter';
export * from './tokens';
export * from './mock-adapter';
export * from './runtime';
export * from './publisher';
