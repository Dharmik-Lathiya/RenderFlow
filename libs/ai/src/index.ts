/**
 * @renderflow/ai
 *
 * AI provider interfaces and their deterministic mocks.
 *
 * AGENTS.md section 8: every integration sits behind an interface, every
 * interface has a mock, and CI never calls a real provider. Production
 * implementations (Phase 6) are added behind the same interfaces without
 * changing a caller.
 *
 * Deliberately dependency-light: it imports only `@renderflow/common` for the
 * shared stage/kind vocabulary, so a worker can depend on the interfaces without
 * dragging in HTTP or database code.
 */

export * from './providers';
export * from './mock-providers';
