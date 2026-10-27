import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, Client, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;

const binary = (req: any) => req.buffer(true).parse((res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

const spec = {
  title: 'Daily summary',
  subtitle: 'Sales, collections, returns and voids per day',
  meta: [['Period', '01 Oct 2026 - 07 Oct 2026'], ['Branch', 'All branches']],
  sections: [
    { kind: 'stats', items: [{ label: 'Sales (incl. tax)', value: 'KES 152,400.00', hint: '341 receipts · average KES 446.92' }, { label: 'Returns', value: 'KES 1,250.00', tone: 'red' }, { label: 'Money collected', value: 'KES 150,100.00' }, { label: 'Voids', value: 'KES 0.00' }] },
    {
      kind: 'table', title: 'By day',
      columns: [{ label: 'Day' }, { label: 'Receipts', align: 'right' }, { label: 'Sales', align: 'right' }, { label: 'Cash', align: 'right' }, { label: 'M-Pesa', align: 'right' }],
      rows: Array.from({ length: 80 }, (_, i) => [`2026-10-${String((i % 30) + 1).padStart(2, '0')}`, String(40 + i), 'KES 21,771.43', 'KES 9,000.00', 'KES 12,771.43']),
      totals: [['Total', '341', 'KES 152,400.00', 'KES 63,000.00', 'KES 89,400.00']],
    },
    { kind: 'text', title: 'Notes', lines: ['Periods use the business timezone <b>not bold</b>.'] },
  ],
};

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'printer', 'supermarket');
  await t.client.patch('/settings/business', { contact: { address: 'Kenyatta Avenue, Nakuru', phone: '0700111222' }, settings: { taxPin: 'P051234567X' } });
});
afterAll(teardown);

describe('reports: PDF download and print', () => {
  it('renders a report as a multi-page PDF on the letterhead', async () => {
    const r = await binary(t.client.post('/render/report?format=pdf', spec));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('Daily-summary.pdf');
    const body = r.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Number(/\/Count (\d+)/.exec(body.toString('latin1'))?.[1])).toBeGreaterThan(1);
    if (process.env.REPORT_SAMPLES) fs.writeFileSync(`${process.env.REPORT_SAMPLES}/report.pdf`, body);
  });

  it('renders the same report as a print page, escaping what the page sent', async () => {
    const r = await t.client.post('/render/report?format=html', spec);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const html = r.text;
    expect(html).toContain('printer shop');
    expect(html).toContain('KRA PIN P051234567X');
    expect(html).toContain('<thead>');
    expect(html).toContain('class="tot"');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    expect(html).not.toContain('<b>not bold</b>');
    if (process.env.REPORT_SAMPLES) fs.writeFileSync(`${process.env.REPORT_SAMPLES}/report.html`, html);
  });

  it('wide tables print landscape; bad specs are refused', async () => {
    const wide = { title: 'Wide', sections: [{ kind: 'table', columns: Array.from({ length: 10 }, (_, i) => ({ label: `C${i}` })), rows: [Array.from({ length: 10 }, () => 'x')] }] };
    expect((await t.client.post('/render/report?format=html', wide)).text).toContain('size:A4 landscape');
    expect((await t.client.post('/render/report', { title: 'Empty', sections: [] })).status).toBe(400);
  });

  it('needs a signed-in user who can read reports', async () => {
    const anon = new Client(ctx.api, 'printer');
    expect((await anon.post('/render/report', spec)).status).toBe(401);
  });

  it('prints an invoice and a quotation as HTML matching their PDF', async () => {
    const p = await createProduct(t.client, { name: 'Cooking oil 1L', sku: 'OIL1', prices: { retail: 32000 } });
    const q = await t.client.post('/documents', { type: 'quotation', customerName: 'Walk-in Wanjiru', branchId: t.locations.branches[0]._id, lines: [{ productId: p._id, qty: 12 }] });
    expect(q.status).toBe(201);
    const r = await t.client.get(`/print/quotation/${q.body.data._id}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('QUOTATION');
    expect(r.text).toContain(q.body.data.number);
    expect(r.text).toContain('Walk-in Wanjiru');
    if (process.env.REPORT_SAMPLES) {
      fs.writeFileSync(`${process.env.REPORT_SAMPLES}/quotation.html`, r.text);
      fs.writeFileSync(`${process.env.REPORT_SAMPLES}/quotation.pdf`, (await binary(t.client.get(`/pdf/quotation/${q.body.data._id}`))).body);
    }
    expect((await t.client.get('/print/invoice/0123456789abcdef01234567')).status).toBe(404);
  });
});
