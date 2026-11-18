/**
 * Built-in answers when no AI provider is set up (or it is down or over its limit): common questions are
 * recognised by their words and answered from the same read-only tools, so the figures are the same.
 */
import { runTool, type ToolContext, today } from './tools.js';

export const SUGGESTIONS = [
  'Which products made the most profit today?',
  'What were my total sales yesterday?',
  'Which products are almost out of stock?',
  'Which products have not sold in 60 days?',
  'Which branch performed best this month?',
  'Which cashier recorded the highest sales this week?',
  'What is my current inventory value?',
  'Which products should I reorder?',
  'What are my best-selling products this month?',
  'Which products have declining sales?',
  'How much revenue did each category generate this month?',
  'What is the difference between revenue and gross profit?',
];

const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);

/** The period a question is about: today, yesterday, this/last week, this/last month (default: today). */
export function periodOf(q: string, tz: string) {
  const t = today(tz);
  const s = q.toLowerCase();
  const dow = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  if (/yesterday|jana/.test(s)) { const y = addDays(t, -1); return { from: y, to: y, label: 'yesterday' }; }
  if (/last week|wiki iliyopita/.test(s)) return { from: addDays(t, -dow - 7), to: addDays(t, -dow - 1), label: 'last week' };
  if (/this week|week|wiki/.test(s)) return { from: addDays(t, -dow), to: t, label: 'this week' };
  if (/last month|mwezi uliopita/.test(s)) { const first = `${t.slice(0, 7)}-01`; const prevLast = addDays(first, -1); return { from: `${prevLast.slice(0, 7)}-01`, to: prevLast, label: 'last month' }; }
  if (/this month|month|mwezi/.test(s)) return { from: `${t.slice(0, 7)}-01`, to: t, label: 'this month' };
  if (/this year|year|mwaka/.test(s)) return { from: `${t.slice(0, 4)}-01-01`, to: t, label: 'this year' };
  return { from: t, to: t, label: 'today' };
}

const kes = (n: number) => `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function builtinAnswer(question: string, ctx: ToolContext): Promise<{ answer: string; tools: { name: string; ok: boolean; error?: string }[] }> {
  const q = question.toLowerCase();
  const p = periodOf(q, ctx.tz);
  const used: { name: string; ok: boolean; error?: string }[] = [];
  const call = async (name: string, input: unknown) => {
    const r = await runTool(name, input, ctx);
    used.push({ name, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    if (!r.ok) throw new Error(r.error);
    return r.result as any;
  };
  try {
    if (/difference between revenue and (gross )?profit|revenue vs|what is (gross )?profit/.test(q)) {
      return { answer: 'Revenue is what customers paid before tax. Gross profit is revenue minus what the goods sold cost you (recorded on each sale at the average buying price). Net profit also takes away running costs such as rent, salaries and electricity (see Accounting → Profit and loss).', tools: used };
    }
    if (/unusual|suspicious|strange|fraud/.test(q)) {
      const r = await call('unusual_activity', { days: 7 });
      if (!r.events.length) return { answer: 'Nothing unusual in the last 7 days: no voids, drawer openings without a sale, or approvals recorded.', tools: used };
      return { answer: `Worth a look (last 7 days):\n${r.events.map((e: any) => `• ${e.what.replace(/[._]/g, ' ')} by ${e.by ?? 'system'}: ${e.times} time(s)`).join('\n')}`, tools: used };
    }
    if (/out of stock|low stock|almost out|running out|reorder level|stock alert/.test(q)) {
      const r = await call('low_stock', { limit: 20 });
      if (!r.products.length) return { answer: 'No product is at or below its reorder level.', tools: used };
      return { answer: `${r.products.length} product(s) at or below the reorder level:\n${r.products.map((x: any) => `• ${x.name}: ${x.onHand} ${x.unit}${x.outOfStock ? ' (out of stock)' : ` (reorder at ${x.reorderLevel})`}`).join('\n')}`, tools: used };
    }
    if (/not sold|haven't sold|dead stock|not selling|slow/.test(q)) {
      const days = Number(/(\d+)\s*(day|siku)/.exec(q)?.[1] ?? 60);
      const r = await call('dead_stock', { days: Math.min(730, Math.max(7, days)), limit: 15 });
      if (!r.productCount) return { answer: `Every product in stock sold in the last ${days} days.`, tools: used };
      return { answer: `${r.productCount} product(s) in stock with no sale in ${days} days${r.totalTiedUpKes !== undefined ? `, holding ${kes(r.totalTiedUpKes)} at cost` : ''}:\n${r.products.map((x: any) => `• ${x.name}: ${x.onHand} ${x.unit ?? ''}${x.valueAtCostKes !== undefined ? ` (${kes(x.valueAtCostKes)})` : ''}`).join('\n')}\nConsider a promotion, a transfer to a branch that sells it, or a supplier return.`, tools: used };
    }
    if (/reorder|should i (order|buy)|purchase order|what to order/.test(q)) {
      const r = await call('reorder_suggestions', {});
      if (!r.orders.length) return { answer: 'Nothing needs ordering: stock and open orders cover the expected sales.', tools: used };
      return { answer: `Suggested orders (${r.basis}):\n${r.orders.map((o: any) => `• ${o.supplier}${o.store ? ` for ${o.store}` : ''}: about ${kes(o.estimatedCostKes)} (${o.lines.map((l: any) => `${l.product} ${l.order} ${l.unit}`).join(', ')})`).join('\n')}\nCreate them as drafts from Purchase orders → Suggested orders.`, tools: used };
    }
    if (/inventory value|stock value|value of (my )?stock|worth of stock/.test(q)) {
      const r = await call('inventory_value', {});
      return { answer: `Stock is worth ${kes(r.totalAtCostKes)} at cost (${kes(r.totalAtRetailKes)} at retail prices).\n${r.stores.map((s: any) => `• ${s.store}: ${kes(s.valueAtCostKes)} at cost`).join('\n')}`, tools: used };
    }
    if (/declin|falling|dropping|growing|rising|trend/.test(q)) {
      const direction = /growing|rising/.test(q) ? 'growing' : 'declining';
      const r = await call('sales_trend', { weeks: 4, direction, limit: 10 });
      if (!r.products.length) return { answer: 'Not enough sales in the last 8 weeks to compare.', tools: used };
      return { answer: `Products with ${direction} sales (${r.compares}):\n${r.products.map((x: any) => `• ${x.name}: ${kes(x.beforeKes)} → ${kes(x.recentKes)} (${x.changePct > 0 ? '+' : ''}${x.changePct}%)`).join('\n')}`, tools: used };
    }
    if (/branch/.test(q)) {
      const r = await call('branch_performance', { from: p.from, to: p.to });
      if (!r.branches.length) return { answer: `No sales ${p.label}.`, tools: used };
      return { answer: `Branches ${p.label}, best first:\n${r.branches.map((b: any) => `• ${b.branch}: ${kes(b.revenueBeforeTaxKes)} revenue, ${b.receipts} receipts${b.grossProfitKes !== undefined ? `, ${kes(b.grossProfitKes)} gross profit` : ''}`).join('\n')}`, tools: used };
    }
    if (/cashier|staff|employee/.test(q)) {
      const r = await call('cashier_performance', { from: p.from, to: p.to });
      if (!r.cashiers.length) return { answer: `No sales ${p.label}.`, tools: used };
      return { answer: `Cashiers ${p.label}, highest sales first:\n${r.cashiers.map((c: any) => `• ${c.cashier}: ${kes(c.salesKes)} from ${c.receipts} receipts${c.voidedReceipts ? `, ${c.voidedReceipts} voided` : ''}`).join('\n')}`, tools: used };
    }
    if (/categor|department/.test(q)) {
      const r = await call('category_revenue', { from: p.from, to: p.to });
      if (!r.categories.length) return { answer: `No sales ${p.label}.`, tools: used };
      return { answer: `Revenue by category ${p.label}:\n${r.categories.map((c: any) => `• ${c.category}: ${kes(c.revenueKes)}`).join('\n')}`, tools: used };
    }
    if (/profit|best.?sell|top|most (sold|popular)|best product/.test(q)) {
      const by = /profit/.test(q) ? 'profit' : /revenue|money|value/.test(q) ? 'revenue' : 'quantity';
      const r = await call('top_products', { from: p.from, to: p.to, by, limit: 10 });
      if (!r.products.length) return { answer: `No sales ${p.label}.`, tools: used };
      return { answer: `Top products ${p.label} by ${by}:\n${r.products.map((x: any, i: number) => `${i + 1}. ${x.name}: ${by === 'quantity' ? `${x.quantity} sold, ` : ''}${kes(x.revenueKes)} revenue${x.grossProfitKes !== undefined ? `, ${kes(x.grossProfitKes)} profit (${x.marginPct}% margin)` : ''}`).join('\n')}`, tools: used };
    }
    if (/sales|sold|revenue|takings|mauzo|how much/.test(q)) {
      const r = await call('sales_summary', { from: p.from, to: p.to });
      if (!r.receipts) return { answer: `No sales ${p.label}.`, tools: used };
      return { answer: `Sales ${p.label}: ${kes(r.grossSalesKes)} from ${r.receipts} receipts (average ${kes(r.averageBasketKes)}). Revenue before tax ${kes(r.revenueBeforeTaxKes)}, tax ${kes(r.taxKes)}${r.discountsKes ? `, discounts ${kes(r.discountsKes)}` : ''}${r.returnsRefundedKes ? `, returns ${kes(r.returnsRefundedKes)}` : ''}.\nPaid by: ${r.byPaymentMethod.map((m: any) => `${m.method} ${kes(m.kes)}`).join(', ')}.`, tools: used };
    }
  } catch (err) {
    return { answer: `I could not get that: ${(err as Error).message}.`, tools: used };
  }
  return { answer: `Without an AI provider set up I can answer questions like:\n${SUGGESTIONS.slice(0, 6).map((s) => `• ${s}`).join('\n')}`, tools: used };
}
