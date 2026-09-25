import type { ReportRange } from '@health24/shared';
import { istToday } from './format';

/**
 * The periods a report is usually asked for (sp6-plan.md, Phase 8).
 *
 * All of them are whole days in India Standard Time, both ends included, which
 * is how the API counts — a report asked for "today" must mean the hospital's
 * today and not the workstation's.
 */

/** A day some number of days before the given IST day. */
export function istDaysBefore(day: string, days: number): string {
  const moved = new Date(`${day}T00:00:00Z`).getTime() - days * 86_400_000;
  return new Date(moved).toISOString().slice(0, 10);
}

/** The month the given day falls in, up to that day. */
export function monthToDate(day: string): ReportRange {
  return { from: `${day.slice(0, 7)}-01`, to: day };
}

/** The whole month before the one the given day falls in. */
export function lastMonth(day: string): ReportRange {
  const end = istDaysBefore(`${day.slice(0, 7)}-01`, 1);
  return { from: `${end.slice(0, 7)}-01`, to: end };
}

/** The financial year the given day falls in: 1 April to 31 March. */
export function financialYear(day: string): ReportRange {
  const year = Number(day.slice(0, 4));
  const startYear = Number(day.slice(5, 7)) >= 4 ? year : year - 1;

  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

export const QUICK_RANGES: Array<{ label: string; range: (today: string) => ReportRange }> = [
  { label: 'Today', range: (today) => ({ from: today, to: today }) },
  { label: 'Last 7 days', range: (today) => ({ from: istDaysBefore(today, 6), to: today }) },
  { label: 'Last 30 days', range: (today) => ({ from: istDaysBefore(today, 29), to: today }) },
  { label: 'This month', range: monthToDate },
];

/** The period a report opens on: the last thirty days, ending today. */
export function defaultRange(): ReportRange {
  const today = istToday();
  return { from: istDaysBefore(today, 29), to: today };
}
