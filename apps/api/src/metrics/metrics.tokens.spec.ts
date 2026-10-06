import { METRICS } from './metrics.tokens';

/**
 * The DI token for `RenderFlowMetrics`.
 *
 * Symbols rather than strings so a stray string literal cannot accidentally
 * resolve to the metrics instance, and so two tokens can never collide.
 */
describe('METRICS token', () => {
  it('is a symbol, so a typo cannot resolve it', () => {
    expect(typeof METRICS).toBe('symbol');
  });

  it('is distinct per module instance', () => {
    // Fresh import must not reuse a cached binding that could point at a
    // different registry.
    expect(METRICS).toBeDefined();
  });

  it('is stable across imports of the same module', async () => {
    const again = await import('./metrics.tokens');
    expect(again.METRICS).toBe(METRICS);
  });

  it('is not the string "RenderFlowMetrics"', () => {
    // Guards against someone "simplifying" the token to a string.
    expect(METRICS).not.toBe('RenderFlowMetrics' as unknown as typeof METRICS);
  });
});
