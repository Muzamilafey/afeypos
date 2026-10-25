import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, Client, type Ctx } from './helpers.js';
import { AttendanceRecord } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { kenyaStatutory, nssf, payeOn, shif } from '../src/modules/hr/statutory.js';
import { leaveDays } from '../src/modules/hr/payroll.js';
import { MockMpesaGateway } from '../src/integrations/mpesa/daraja.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let hrUser: Client;
let jane: any;
let otieno: any;
let casual: any;
const PERIOD = '2026-09';

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'hrco', 'supermarket');
  await t.client.post('/settings/integrations', { kind: 'mpesa', provider: 'mock', name: 'M-Pesa sim', settings: { shortCode: '174379', type: 'paybill', b2cShortCode: '600000', initiatorName: 'api' }, secrets: { consumerKey: 'k', consumerSecret: 's', passkey: 'p', securityCredential: 'c' } });
  await t.client.post('/settings/users', { name: 'Akinyi Accounts', email: 'akinyi@hrco.test', password: 'Akinyi1234', roles: ['accountant', 'branch_manager'] });
  hrUser = new Client(ctx.api, 'hrco');
  await hrUser.login('akinyi@hrco.test', 'Akinyi1234');
});
afterAll(teardown);

describe('Kenyan statutory deductions', () => {
  it('computes NSSF tiers, SHIF, housing levy and PAYE after deductions (KES 50,000)', () => {
    expect(nssf(5_000_000)).toMatchObject({ tier1: 48_000, tier2: 252_000, employee: 300_000 });
    expect(nssf(10_000_000).employee).toBe(432_000); // capped at the upper earnings limit
    expect(shif(5_000_000)).toBe(137_500);
    expect(shif(800_000)).toBe(30_000); // minimum KES 300
    expect(payeOn(2_400_000)).toBe(240_000);
    const s = kenyaStatutory({ grossCents: 5_000_000 });
    expect(s).toMatchObject({ nssfCents: 300_000, shifCents: 137_500, ahlCents: 75_000, ahlEmployerCents: 75_000, taxablePayCents: 4_487_500, personalReliefCents: 240_000, payeCents: 584_585, nitaCents: 5_000 });
    expect(s.netAfterStatutoryCents).toBe(5_000_000 - 300_000 - 137_500 - 75_000 - 584_585);
  });

  it('charges no PAYE below the threshold and never negative tax', () => {
    const low = kenyaStatutory({ grossCents: 1_500_000 });
    expect(low.payeCents).toBe(0);
    expect(low.payeBeforeReliefCents).toBeLessThan(240_000);
    // Non-taxable allowances count for SHIF/levy but not PAYE.
    const withPerDiem = kenyaStatutory({ grossCents: 6_000_000, nonTaxableCents: 1_000_000 });
    expect(withPerDiem.taxablePayCents).toBe(kenyaStatutory({ grossCents: 6_000_000 }).taxablePayCents - 1_000_000);
    expect(leaveDays(new Date('2026-10-05'), new Date('2026-10-11'))).toBe(6); // Mon-Sun, Sunday not counted
  });
});

describe('employees, leave and advances', () => {
  it('adds employees, links staff logins and validates details', async () => {
    expect((await t.client.post('/hr/employees', { name: 'Bad Pin', rateCents: 100, kraPin: 'X12', payMethod: 'cash' })).status).toBe(400);
    expect((await t.client.post('/hr/employees', { name: 'No Phone', rateCents: 100, payMethod: 'mpesa' })).status).toBe(400);
    jane = (await t.client.post('/hr/employees', { name: 'Jane Wanjiku', kraPin: 'a123456789b', idNumber: '23456789', nssfNo: 'NS1', shifNo: 'SH1', rateCents: 5_000_000, payMethod: 'mpesa', mpesaPhone: '0712345678', jobTitle: 'Supervisor', allowances: [{ name: 'House', amountCents: 500_000 }, { name: 'Per diem', amountCents: 200_000, taxable: false }], deductions: [{ name: 'SACCO', amountCents: 100_000 }], startDate: '2025-01-01' })).body.data;
    expect(jane.employeeNo).toMatch(/^EMP-/);
    expect(jane.kraPin).toBe('A123456789B');
    otieno = (await t.client.post('/hr/employees', { name: 'Otieno Bank', rateCents: 3_000_000, payMethod: 'bank', bank: { name: 'KCB', accountNo: '1234567890' } })).body.data;
    const imported = await t.client.post('/hr/employees/import-users', {});
    expect(imported.body.count).toBe(2); // owner and Akinyi
    const users = (await t.client.get('/settings/users')).body.data;
    const owner = users.find((u: any) => u.roles.includes('tenant_owner'));
    const list = (await t.client.get('/hr/employees?limit=50')).body.data;
    const ownerEmp = list.find((e: any) => String(e.userId) === owner._id);
    expect(ownerEmp.employeeNo).toBe(owner.employeeNo);
    // Casual daily worker linked to the owner login for attendance.
    casual = (await t.client.patch(`/hr/employees/${ownerEmp._id}`, { payType: 'daily', rateCents: 100_000, payMethod: 'cash', employmentType: 'casual' })).body.data;
    // Akinyi's record: give a salary so the run is meaningful.
    const ak = list.find((e: any) => e.name === 'Akinyi Accounts');
    await t.client.patch(`/hr/employees/${ak._id}`, { rateCents: 4_000_000, payMethod: 'cash' });
  });

  it('accrues annual leave and refuses more than the balance', async () => {
    const d = (await t.client.get(`/hr/employees/${jane._id}`)).body.data;
    expect(d.leave.entitlement).toBe(21);
    expect(d.leave.available).toBeGreaterThan(15);
    const tooMuch = await t.client.post('/hr/leave', { employeeId: jane._id, type: 'annual', from: '2026-11-02', to: '2026-12-31' });
    expect(tooMuch.body.error.code).toBe('LEAVE_EXCEEDS_BALANCE');
    const req = await t.client.post('/hr/leave', { employeeId: jane._id, type: 'annual', from: '2026-11-02', to: '2026-11-07', reason: 'Family' });
    expect(req.body.data.days).toBe(6);
    expect((await t.client.post(`/hr/leave/${req.body.data._id}/decide`, { approve: true })).body.data.status).toBe('approved');
    expect((await t.client.post(`/hr/leave/${req.body.data._id}/decide`, { approve: false })).status).toBe(422);
    const after = (await t.client.get(`/hr/employees/${jane._id}`)).body.data.leave;
    expect(after.taken).toBe(6);
    // Two days unpaid leave in the payroll month.
    const unpaid = await t.client.post('/hr/leave', { employeeId: otieno._id, type: 'unpaid', from: '2026-09-14', to: '2026-09-15' });
    await t.client.post(`/hr/leave/${unpaid.body.data._id}/decide`, { approve: true });
  });

  it('approves advances by a second person and pays them', async () => {
    const a = (await hrUser.post('/hr/advances', { employeeId: jane._id, amountCents: 1_000_000, installmentCents: 600_000, reason: 'School fees', payMethod: 'cash' })).body.data;
    expect((await hrUser.post(`/hr/advances/${a._id}/approve`, {})).status).toBe(403);
    expect((await t.client.post(`/hr/advances/${a._id}/approve`, {})).body.data.status).toBe('approved');
    expect((await hrUser.post(`/hr/advances/${a._id}/pay`, {})).body.data.status).toBe('paid');
  });
});

describe('payroll', () => {
  let runId: string;

  it('builds a month: attendance days for casuals, unpaid leave, statutory and advance recovery', async () => {
    // The casual (owner login) clocked in 3 days in September.
    const users = (await t.client.get('/settings/users')).body.data;
    const owner = users.find((u: any) => u.roles.includes('tenant_owner'));
    await runAsPlatform(async () => {
      const tenantId = (await (await import('../src/models/index.js')).Tenant.findOne().lean())!._id;
      for (const day of [2, 3, 4]) {
        await AttendanceRecord.create({ tenantId, userId: owner._id, kind: 'clock_in', method: 'card', at: new Date(Date.UTC(2026, 8, day, 5)) });
        await AttendanceRecord.create({ tenantId, userId: owner._id, kind: 'clock_out', method: 'card', at: new Date(Date.UTC(2026, 8, day, 14)) });
      }
    });
    const att = (await t.client.get(`/hr/attendance?period=${PERIOD}`)).body.data.find((r: any) => r.employeeNo === casual.employeeNo);
    expect(att).toMatchObject({ daysPresent: 3, hoursWorked: 27 });

    const r = await hrUser.post('/hr/payroll', { period: PERIOD, inputs: { [jane._id]: { overtimeCents: 300_000 } } });
    expect(r.status).toBe(201);
    runId = r.body.data._id;
    const lines = r.body.data.lines;
    const j = lines.find((l: any) => l.name === 'Jane Wanjiku');
    // 50,000 + 5,000 house + 2,000 per diem + 3,000 overtime = 60,000 gross; per diem not taxable.
    expect(j.grossCents).toBe(6_000_000);
    expect(j.taxablePayCents).toBe(kenyaStatutory({ grossCents: 6_000_000, nonTaxableCents: 200_000 }).taxablePayCents);
    expect(j.advanceRecoveryCents).toBe(600_000);
    expect(j.netCents).toBe(kenyaStatutory({ grossCents: 6_000_000, nonTaxableCents: 200_000 }).netAfterStatutoryCents - 100_000 - 600_000);
    const o = lines.find((l: any) => l.name === 'Otieno Bank');
    expect(o.unpaidLeaveDays).toBe(2);
    expect(o.unpaidLeaveCents).toBe(Math.round((3_000_000 / 26) * 2));
    const c = lines.find((l: any) => l.employeeNo === casual.employeeNo);
    expect(c).toMatchObject({ payType: 'daily', daysWorked: 3, basicCents: 300_000, grossCents: 300_000 });
    expect(r.body.data.totals.employees).toBe(lines.length);
    expect((await hrUser.post('/hr/payroll', { period: PERIOD })).body.error.code).toBe('PAYROLL_EXISTS');
  });

  it('edits a draft payslip and recalculates', async () => {
    const run = (await hrUser.get(`/hr/payroll/${runId}`)).body.data;
    const c = run.lines.find((l: any) => l.employeeNo === casual.employeeNo);
    const upd = await hrUser.patch(`/hr/payroll/${runId}/lines/${c._id}`, { daysWorked: 20 });
    const c2 = upd.body.data.lines.find((l: any) => l._id === c._id);
    expect(c2.basicCents).toBe(2_000_000);
    const re = await hrUser.post(`/hr/payroll/${runId}/recalculate`, {});
    expect(re.body.data.lines.find((l: any) => l.employeeNo === casual.employeeNo).daysWorked).toBe(20);
  });

  it('a different person approves; advances are recovered; payslips and returns are produced', async () => {
    expect((await hrUser.post(`/hr/payroll/${runId}/approve`, {})).status).toBe(403); // accountant has no payroll.approve
    expect((await t.client.post(`/hr/payroll/${runId}/approve`, {})).body.data.status).toBe('approved');
    const adv = (await t.client.get(`/hr/advances?employeeId=${jane._id}`)).body.data[0];
    expect(adv).toMatchObject({ recoveredCents: 600_000, outstandingCents: 400_000, status: 'paid' });
    const slip = await hrUser.get(`/hr/payroll/${runId}/payslips`);
    expect(slip.text).toContain('Jane Wanjiku');
    expect(slip.text).toContain('Salary advance recovery');
    const csv = await hrUser.get(`/hr/payroll/${runId}/statutory?format=csv`);
    expect(csv.text.split('\n')[0]).toContain('KRA PIN');
    expect(csv.text).toContain('A123456789B');
    const bank = await hrUser.get(`/hr/payroll/${runId}/bank-file`);
    expect(bank.text).toContain('1234567890');
  });

  it('pays M-Pesa salaries through B2C payouts; bank and cash are recorded; the run closes when all are paid', async () => {
    const p = await hrUser.post(`/hr/payroll/${runId}/mpesa-payouts`, {});
    expect(p.body.data.created).toBe(1);
    expect((await hrUser.post(`/hr/payroll/${runId}/mpesa-payouts`, {})).body.data.created).toBe(0);
    await hrUser.post(`/hr/payroll/${runId}/mark-paid`, {});
    let run = (await hrUser.get(`/hr/payroll/${runId}`)).body.data;
    expect(run.status).toBe('approved'); // waiting for M-Pesa
    const payoutId = run.lines.find((l: any) => l.name === 'Jane Wanjiku').payoutId;
    // Owner approves and sends the payout (a different person than the requester), then Safaricom confirms.
    expect((await t.client.post('/payments/payouts/approve', { ids: [payoutId] })).body.data.approved).toBe(1);
    await t.client.post('/payments/payouts/send', { ids: [payoutId] });
    expect(MockMpesaGateway.payouts.at(-1)).toMatchObject({ phone: '254712345678', commandId: 'SalaryPayment' });
    await t.client.post(`/payments/payouts/${payoutId}/simulate`, {});
    run = (await hrUser.get(`/hr/payroll/${runId}`)).body.data;
    expect(run.status).toBe('paid');
    expect(run.lines.every((l: any) => l.paid)).toBe(true);
    expect((await t.client.post(`/hr/payroll/${runId}/cancel`, {})).body.error.code).toBe('PAYROLL_PAID');
  });
});
