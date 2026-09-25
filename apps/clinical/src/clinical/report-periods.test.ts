import { describe, expect, it } from 'vitest';
import { financialYear, istDaysBefore, lastMonth, monthToDate } from './report-periods';

describe('report periods', () => {
  it('steps back whole days across a month boundary', () => {
    expect(istDaysBefore('2026-03-02', 3)).toBe('2026-02-27');
    expect(istDaysBefore('2026-01-01', 1)).toBe('2025-12-31');
  });

  it('takes the month up to the day asked for', () => {
    expect(monthToDate('2026-09-25')).toEqual({ from: '2026-09-01', to: '2026-09-25' });
  });

  it('takes the whole month before, however long it was', () => {
    expect(lastMonth('2026-03-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(lastMonth('2024-03-14')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(lastMonth('2026-01-09')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('runs the financial year from April to March', () => {
    expect(financialYear('2026-09-25')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(financialYear('2026-03-31')).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(financialYear('2026-04-01')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
});
