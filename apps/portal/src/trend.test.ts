import { describe, expect, it } from 'vitest';
import { niceTicks } from './trend';

describe('value axis ticks', () => {
  it('covers the values with round steps', () => {
    expect(niceTicks(7, 72)).toEqual([0, 20, 40, 60, 80]);
  });

  it('opens a range around a single value', () => {
    const ticks = niceTicks(5, 5);
    expect(ticks[0]).toBeLessThan(5);
    expect(ticks.at(-1)).toBeGreaterThan(5);
  });
});
