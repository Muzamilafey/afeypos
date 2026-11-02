import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, type Ctx } from './helpers.js';

// The Anthropic SDK is replaced by a scripted fake: no real API calls in tests.
const calls: any[] = [];
let script: ((req: any) => any)[] = [];
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    beta = { messages: { create: async (req: any) => { calls.push(JSON.parse(JSON.stringify(req))); const step = script.shift(); if (!step) throw new Error('no scripted reply'); return step(req); } } };
  }
  return { default: FakeAnthropic };
});

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'askshop', 'supermarket', {}, ['multiBranch']);
  const p = await createProduct(t.client, { name: 'Sugar 2kg', sku: 'SUG', prices: { retail: 26000 }, costCents: 20000, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 30 }] });
  await createProduct(t.client, { name: 'Salt', sku: 'SALT', prices: { retail: 5000 }, reorderLevel: 5, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 2 }] });
  const shift = await openShift(t.client, t.locations.tills[0]._id);
  await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 3 }], payments: [{ method: 'cash', amountCents: 78000 }] });
  await t.client.post(`/shifts/${shift._id}/close`, { countedCashCents: 78000 });
});
afterAll(teardown);

describe('AI business assistant', () => {
  it('answers common questions from real data without any AI provider', async () => {
    const st = (await t.client.get('/assistant/status')).body.data;
    expect(st.mode).toBe('builtin');
    const sales = (await t.client.post('/assistant/ask', { question: 'What were my total sales today?' })).body.data;
    expect(sales.mode).toBe('builtin');
    expect(sales.answer).toMatch(/KES 780\.00 from 1 receipts/);
    const profit = (await t.client.post('/assistant/ask', { question: 'Which products made the most profit today?' })).body.data;
    expect(profit.answer).toMatch(/Sugar 2kg/);
    const low = (await t.client.post('/assistant/ask', { question: 'Which products are almost out of stock?' })).body.data;
    expect(low.answer).toMatch(/Salt: 2/);
    const gp = (await t.client.post('/assistant/ask', { question: 'What is the difference between revenue and gross profit?' })).body.data;
    expect(gp.answer).toMatch(/Net profit/);
  });

  it('only users with assistant.use may ask, and tools follow their permissions', async () => {
    await t.client.post('/settings/users', { name: 'Cash', email: 'cash@askshop.test', password: 'Passw0rd!x', roles: ['cashier'] });
    const cashier = new Client(ctx.api, 'askshop');
    await cashier.login('cash@askshop.test', 'Passw0rd!x');
    expect((await cashier.post('/assistant/ask', { question: 'sales today' })).status).toBe(403);
    await t.client.post('/settings/users', { name: 'Inv', email: 'inv@askshop.test', password: 'Passw0rd!x', roles: ['inventory_manager'] });
    const inv = new Client(ctx.api, 'askshop');
    await inv.login('inv@askshop.test', 'Passw0rd!x');
    // No assistant permission on that role either.
    expect((await inv.get('/assistant/status')).status).toBe(403);
  });

  it('with Claude set up, runs the tool loop with the user\'s tools and logs it; the key is never returned', async () => {
    expect((await t.client.put('/assistant/config', { enabled: true, provider: 'anthropic' })).body.error.code).toBe('ASSISTANT_KEY_REQUIRED');
    expect((await t.client.put('/assistant/config', { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-test-1234567890' })).body.ok).toBe(true);
    const cfg = (await t.client.get('/assistant/config')).body.data;
    expect(cfg).toMatchObject({ enabled: true, provider: 'anthropic', hasKey: true });
    expect(JSON.stringify(cfg)).not.toContain('sk-ant-test');

    const today = new Date().toISOString().slice(0, 10);
    script = [
      () => ({ model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 60 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'sales_summary', input: { from: today, to: today } }] }),
      (req) => {
        const result = req.messages.at(-1).content[0];
        expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
        expect(JSON.parse(result.content).receipts).toBe(1);
        return { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 40 }, content: [{ type: 'text', text: 'Today you sold KES 780.00 from 1 receipt.' }] };
      },
    ];
    const r = (await t.client.post('/assistant/ask', { question: 'How did we do today?' })).body.data;
    expect(r).toMatchObject({ mode: 'ai', answer: 'Today you sold KES 780.00 from 1 receipt.', tools: ['sales_summary'] });
    const first = calls[0];
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.fallbacks).toBe('default');
    expect(first.tools.map((x: any) => x.name)).toEqual(expect.arrayContaining(['sales_summary', 'top_products', 'low_stock', 'unusual_activity']));
    expect(first.system).toContain('Never make up a figure');
    // The assistant turn with the tool call is sent back as it came.
    expect(calls[1].messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1' }] });

    const log = (await t.client.get('/assistant/log')).body;
    expect(log.data[0]).toMatchObject({ mode: 'ai', model: 'claude-opus-5-5', inputTokens: 2100, outputTokens: 100, ok: true, tools: [{ name: 'sales_summary', ok: true }] });
  });

  it('a bad tool input is returned to the model as an error, and a provider failure falls back to built-in answers', async () => {
    script = [
      () => ({ model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu_2', name: 'sales_summary', input: { from: 'yesterday' } }] }),
      (req) => {
        const res = req.messages.at(-1).content[0];
        expect(res.is_error).toBe(true);
        expect(res.content).toMatch(/Invalid input/);
        return { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Could you give the dates?' }] };
      },
    ];
    expect((await t.client.post('/assistant/ask', { question: 'sales?' })).body.data.answer).toBe('Could you give the dates?');

    script = [() => { throw new Error('overloaded'); }];
    const down = (await t.client.post('/assistant/ask', { question: 'What were my total sales today?' })).body.data;
    expect(down.mode).toBe('builtin');
    expect(down.answer).toMatch(/KES 780\.00/);
    expect(down.answer).toMatch(/AI service did not answer/);
  });
});
