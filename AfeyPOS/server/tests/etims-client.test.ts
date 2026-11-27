import { afterEach, describe, expect, it, vi } from 'vitest';
import { EtimsClient, type EtimsSale } from '../src/integrations/etims/client.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('VSCU protocol compatibility', () => {
  it('uses the installation-guide route when available', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init });
      return json({ resultCd: '000', data: { info: { tin: 'P051234567X', bhfId: '00', sdcId: 'CU123', mrcNo: 'MRC123' } } });
    });
    const client = new EtimsClient({ mode: 'vscu', environment: 'production', tin: 'P051234567X', bhfId: '00', dvcSrlNo: 'DVC123', baseUrl: 'http://127.0.0.1:8088' });

    const info = await client.initialize();

    expect(info).toMatchObject({ sdcId: 'CU123', mrcNo: 'MRC123', vscuApiVersion: 'legacy' });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8088/selectInitOsdcInfo');
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ tin: 'P051234567X', bhfId: '00', dvcSrlNo: 'DVC123' });
  });

  it('falls back to the VSCU spec routes on HTTP 404 and maps the returned signature', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/selectInitOsdcInfo')) return new Response('', { status: 404 });
      if (url.endsWith('/initializer/selectInitInfo')) return json({ resultCd: '000', data: { info: { tin: 'P051234567X', bhfId: '00', sdcId: 'CU456', mrcNo: 'MRC456', cmcKey: null } } });
      return json({ resultCd: '000', data: { rcptNo: 12, totRcptNo: 34, intrlData: 'INTERNAL', rcptSign: 'SIGNATURE', VSCURcptPbctDate: '20261127123045', sdcId: 'CU456', mrcNo: 'MRC456' } });
    });
    const client = new EtimsClient({ mode: 'vscu', environment: 'production', tin: 'P051234567X', bhfId: '00', dvcSrlNo: 'DVC456', baseUrl: 'http://127.0.0.1:8088' });

    const info = await client.initialize();
    const signature = await client.saveSale({ invcNo: 1, itemList: [] } as unknown as EtimsSale);

    expect(info.vscuApiVersion).toBe('v2');
    expect(calls.map((x) => x.url)).toEqual([
      'http://127.0.0.1:8088/selectInitOsdcInfo',
      'http://127.0.0.1:8088/initializer/selectInitInfo',
      'http://127.0.0.1:8088/trnsSales/saveSales',
    ]);
    expect(signature).toMatchObject({ curRcptNo: 12, totRcptNo: 34, intrlData: 'INTERNAL', rcptSign: 'SIGNATURE', sdcDateTime: '20261127123045' });
    expect((calls[2]!.init?.headers as Record<string, string>).tin).toBeUndefined();
    expect(JSON.parse(String(calls[2]!.init?.body))).toMatchObject({ tin: 'P051234567X', bhfId: '00' });
  });

  it('does not treat KRA URL or validation errors as successful duplicate invoices', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ resultCd: '891', resultMsg: 'An error occurred while Request URL is created.' }));
    const client = new EtimsClient({ mode: 'oscu', environment: 'sandbox', tin: 'P051234567X', bhfId: '00', cmcKey: 'CMC' });

    await expect(client.saveSale({ invcNo: 1, itemList: [] } as unknown as EtimsSale)).rejects.toThrow(/eTIMS 891/);
  });
});
