/** "+91••••••3210": enough to recognise a number, not to use it. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '••••';
  return `${phone.slice(0, 3)}${'•'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}
