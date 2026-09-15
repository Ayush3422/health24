import { describe, expect, it } from 'vitest';
import { niceTicks } from './TrendChart';

describe('trend chart ticks', () => {
  it('covers the values with round steps', () => {
    const ticks = niceTicks(23, 187);
    expect(ticks[0]).toBeLessThanOrEqual(23);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(187);
    expect(ticks).toEqual([0, 50, 100, 150, 200]);
  });

  it('keeps decimal steps exact', () => {
    expect(niceTicks(5.6, 6.9)).toEqual([5.5, 6, 6.5, 7]);
  });

  it('spreads a single repeated value around itself', () => {
    const ticks = niceTicks(42, 42);
    expect(ticks[0]).toBeLessThan(42);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(42);
  });
});
