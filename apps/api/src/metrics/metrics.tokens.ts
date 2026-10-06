/**
 * Nest DI tokens that live in the app rather than in a lib, so `@renderflow/*`
 * never has to depend on Nest (AGENTS.md section 3 dependency rules).
 */
export const METRICS = Symbol('RENDERFLOW_METRICS');
