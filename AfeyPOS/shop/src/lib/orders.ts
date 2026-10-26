/** Orders placed from this browser, so "Account" can list them without a sign-in. */
export interface SavedOrder { number: string; token: string; totalCents: number; at: string }
const KEY = 'afey.shop.orders';

export function savedOrders(): SavedOrder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function rememberOrder(o: SavedOrder) {
  try {
    localStorage.setItem(KEY, JSON.stringify([o, ...savedOrders().filter((x) => x.number !== o.number)].slice(0, 20)));
  } catch {
    /* storage unavailable */
  }
}
