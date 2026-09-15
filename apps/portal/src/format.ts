/** Dates and numbers as Indians read them, in India Standard Time (sp5-plan.md, DF8). */

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** A calendar date (YYYY-MM-DD) or an instant, as "12 Apr 2026". */
export function formatDate(value: string): string {
  // A bare date is a day in India, not midnight UTC.
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+05:30` : value;
  return dateFormat.format(new Date(instant));
}

export function formatDateTime(value: string): string {
  return dateTimeFormat.format(new Date(value));
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** A file's size: kilobytes under a megabyte, never "0 MB". */
export function formatBytes(bytes: number): string {
  const megabyte = 1024 * 1024;
  if (bytes < megabyte) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-IN')} KB`;
  return `${(bytes / megabyte).toLocaleString('en-IN', { maximumFractionDigits: 1 })} MB`;
}

/** "+91 98200 12345" from E.164 or a typed number, for showing back what was entered. */
export function displayPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.slice(-10);
  return local.length === 10 ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : phone;
}

/** A browser's user agent as a short device description. */
export function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;

  const system = /Android/i.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/i.test(userAgent)
      ? 'iPhone or iPad'
      : /Windows/i.test(userAgent)
        ? 'Windows'
        : /Mac OS/i.test(userAgent)
          ? 'Mac'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;

  return [browser, system].filter(Boolean).join(' on ') || null;
}
