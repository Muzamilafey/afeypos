let currency = 'KES';
export const setCurrency = (c: string) => {
  currency = c;
};
export const money = (cents: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2 }).format((cents ?? 0) / 100);
export const dateTime = (d: string | Date) => new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
