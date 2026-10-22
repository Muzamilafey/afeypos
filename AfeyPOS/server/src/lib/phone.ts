/** Normalises Kenyan and international phone numbers to E.164 digits without '+', e.g. 254712345678. */
export function normalizePhone(input: string, defaultCountryCode = '254'): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = defaultCountryCode + d.slice(1);
  if ((d.startsWith('7') || d.startsWith('1')) && d.length === 9 && defaultCountryCode === '254') d = '254' + d;
  if (!/^\d{10,15}$/.test(d)) return null;
  return d;
}

export function isKenyanMobile(msisdn: string): boolean {
  return /^254(7|1)\d{8}$/.test(msisdn);
}
