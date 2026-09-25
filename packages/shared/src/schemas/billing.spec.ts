import { describe, expect, it } from 'vitest';
import { formatPaise, paiseFromRupees, paiseSchema } from './billing.js';

/**
 * Money, to the paisa (sp6-plan.md, T23).
 *
 * Everything in the system counts money in whole paise; rupees exist only at
 * the two edges, where a person types them and where a person reads them.
 * These are those two edges, which is where a rounding error would get in.
 */
describe('money', () => {
  it('reads paise as rupees, grouped the Indian way', () => {
    expect(formatPaise(0)).toBe('₹0.00');
    expect(formatPaise(5)).toBe('₹0.05');
    expect(formatPaise(50)).toBe('₹0.50');
    expect(formatPaise(125_000)).toBe('₹1,250.00');
    expect(formatPaise(125_050)).toBe('₹1,250.50');
    // Lakh and crore, not thousands: a crore of rupees is 1,00,00,000.
    expect(formatPaise(1_000_000_000)).toBe('₹1,00,00,000.00');
  });

  it('shows what is owed back with its sign, rather than as a smaller number', () => {
    expect(formatPaise(-2_500)).toBe('-₹25.00');
    expect(formatPaise(-5)).toBe('-₹0.05');
  });

  it('takes rupees as a person types them', () => {
    expect(paiseFromRupees('300')).toBe(30_000);
    expect(paiseFromRupees('1250.50')).toBe(125_050);
    expect(paiseFromRupees('1,250.50')).toBe(125_050);
    expect(paiseFromRupees('₹ 1,250.50')).toBe(125_050);
    // One decimal place is tenths of a rupee, not of a paisa.
    expect(paiseFromRupees('12.5')).toBe(1_250);
  });

  it('refuses what is not an amount, rather than guessing at it', () => {
    expect(paiseFromRupees('')).toBeNull();
    expect(paiseFromRupees('abc')).toBeNull();
    expect(paiseFromRupees('-25')).toBeNull();
    // Three decimal places is a fraction of a paisa, which does not exist.
    expect(paiseFromRupees('25.123')).toBeNull();
    expect(paiseFromRupees('25.')).toBeNull();
  });

  it('makes the same number of the same amount, whichever way it is written', () => {
    for (const paise of [1, 99, 100, 12_345, 999_999, 1_00_00_000]) {
      expect(paiseFromRupees(formatPaise(paise))).toBe(paise);
    }
  });

  it('holds the line at whole paise', () => {
    expect(paiseSchema.safeParse(12_345).success).toBe(true);
    expect(paiseSchema.safeParse(0).success).toBe(true);
    expect(paiseSchema.safeParse(12.5).success).toBe(false);
    expect(paiseSchema.safeParse(-1).success).toBe(false);
  });
});
