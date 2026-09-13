/**
 * Dates as the hospital reads them: India Standard Time, day before month,
 * whatever the workstation's own clock settings.
 */
const TIME_ZONE = 'Asia/Kolkata';

export function formatDate(value: string | null): string {
  if (!value) return '—';

  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: TIME_ZONE,
  });
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  });
}

export const formatDateTime = (value: string): string =>
  `${formatDate(value)}, ${formatTime(value)}`;

/** Today's date in India Standard Time, as YYYY-MM-DD. */
export function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export const humanise = (value: string): string => value.replace(/_/g, ' ');

/** An optional text field: trimmed, or left out entirely. */
export const optionalText = (value: string): string | undefined =>
  value.trim() ? value.trim() : undefined;
