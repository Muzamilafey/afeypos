/**
 * KRA eTIMS client for OSCU (Online Sales Control Unit: KRA's online API) and VSCU (Virtual Sales Control
 * Unit: KRA's signing software installed on the shop network, which exposes the same API locally).
 *
 * Every request carries the headers tin, bhfId and cmcKey (the communication key returned by device
 * initialisation). Amounts are decimal shillings; dates are East Africa Time.
 */
import { httpJson, IntegrationError } from '../http.js';

export interface EtimsConfig {
  mode: 'oscu' | 'vscu';
  environment: 'sandbox' | 'production';
  /** Taxpayer KRA PIN, e.g. P051234567X. */
  tin: string;
  /** Branch id registered with KRA: "00" for head office, "01", "02"... for branches. */
  bhfId: string;
  /** Device serial number used at initialisation. */
  dvcSrlNo?: string;
  /** Communication key from initialisation. */
  cmcKey?: string;
  /** VSCU address (e.g. http://192.168.1.5:8088) or an override for OSCU. */
  baseUrl?: string;
}

export interface EtimsResponse<T = any> {
  resultCd: string;
  resultMsg: string;
  resultDt?: string;
  data?: T;
}

export interface EtimsItem {
  itemCd: string;
  itemClsCd: string;
  itemTyCd: string;
  itemNm: string;
  orgnNatCd: string;
  pkgUnitCd: string;
  qtyUnitCd: string;
  taxTyCd: string;
  bcd?: string | null;
  dftPrc: number;
  isrcAplcbYn: 'Y' | 'N';
  useYn: 'Y' | 'N';
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
}

export interface EtimsSaleLine {
  itemSeq: number;
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd?: string | null;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  prc: number;
  splyAmt: number;
  dcRt: number;
  dcAmt: number;
  taxTyCd: string;
  taxblAmt: number;
  taxAmt: number;
  totAmt: number;
}

export interface EtimsSale {
  invcNo: number;
  orgInvcNo: number;
  trdInvcNo: string;
  custTin?: string | null;
  custNm?: string | null;
  salesTyCd: 'N';
  rcptTyCd: 'S' | 'R';
  pmtTyCd: string;
  salesSttsCd: '02';
  cfmDt: string;
  salesDt: string;
  rfdDt?: string | null;
  rfdRsnCd?: string | null;
  totItemCnt: number;
  taxblAmtA: number; taxblAmtB: number; taxblAmtC: number; taxblAmtD: number; taxblAmtE: number;
  taxRtA: number; taxRtB: number; taxRtC: number; taxRtD: number; taxRtE: number;
  taxAmtA: number; taxAmtB: number; taxAmtC: number; taxAmtD: number; taxAmtE: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  prchrAcptcYn: 'N';
  remark?: string | null;
  regrId: string; regrNm: string; modrId: string; modrNm: string;
  receipt: { custTin?: string | null; custMblNo?: string | null; rptNo: number; trdeNm?: string; adrs?: string; topMsg?: string; btmMsg?: string; prchrAcptcYn: 'N' };
  itemList: EtimsSaleLine[];
}

export interface EtimsSignature {
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;
  rcptSign: string;
  sdcDateTime: string;
  sdcId?: string;
  mrcNo?: string;
}

export interface EtimsGateway {
  initialize(): Promise<{ sdcId?: string; mrcNo?: string; cmcKey?: string; bhfNm?: string; taxprNm?: string }>;
  saveItem(item: EtimsItem): Promise<void>;
  saveSale(sale: EtimsSale): Promise<EtimsSignature>;
}

const OK = '000';
/** "Already registered" style answers that mean the record is already at KRA. */
const ALREADY = new Set(['891', '921', '994']);

export class EtimsClient implements EtimsGateway {
  constructor(private cfg: EtimsConfig) {}

  get baseUrl() {
    if (this.cfg.baseUrl) return this.cfg.baseUrl.replace(/\/$/, '');
    if (this.cfg.mode === 'vscu') throw new IntegrationError('Set the VSCU address (e.g. http://192.168.1.5:8088)', undefined, undefined, false);
    return this.cfg.environment === 'production' ? 'https://etims-api.kra.go.ke/etims-api' : 'https://etims-api-sbx.kra.go.ke/etims-api';
  }

  private async post<T>(path: string, body: Record<string, unknown>, needKey = true): Promise<EtimsResponse<T>> {
    if (needKey && !this.cfg.cmcKey) throw new IntegrationError('Initialise the eTIMS device first (no communication key yet)', undefined, undefined, false);
    const r = await httpJson<EtimsResponse<T>>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', tin: this.cfg.tin, bhfId: this.cfg.bhfId, ...(needKey ? { cmcKey: this.cfg.cmcKey! } : {}) },
      body: JSON.stringify({ tin: this.cfg.tin, bhfId: this.cfg.bhfId, ...body }),
      timeoutMs: 20_000,
    });
    if (r?.resultCd !== OK && !ALREADY.has(String(r?.resultCd))) {
      // KRA validation errors will not succeed on retry; connectivity errors (thrown above) will.
      throw new IntegrationError(`eTIMS ${r?.resultCd ?? '?'}: ${r?.resultMsg ?? 'rejected'}`, undefined, r, false);
    }
    return r;
  }

  async initialize() {
    if (!this.cfg.dvcSrlNo) throw new IntegrationError('Enter the device serial number issued by KRA', undefined, undefined, false);
    const r = await this.post<{ info?: Record<string, string> }>('/selectInitOsdcInfo', { dvcSrlNo: this.cfg.dvcSrlNo }, false);
    const info = r.data?.info ?? {};
    return { sdcId: info.sdcId, mrcNo: info.mrcNo, cmcKey: info.cmcKey, bhfNm: info.bhfNm, taxprNm: info.taxprNm };
  }

  async saveItem(item: EtimsItem) {
    await this.post('/saveItem', item as unknown as Record<string, unknown>);
  }

  async saveSale(sale: EtimsSale) {
    const r = await this.post<EtimsSignature>('/saveTrnsSalesOsdc', sale as unknown as Record<string, unknown>);
    if (!r.data?.rcptSign) throw new IntegrationError('eTIMS did not return a receipt signature', undefined, r, true);
    return r.data;
  }
}

/** Offline eTIMS for training and tests: signs deterministically, never contacts KRA. */
export class MockEtimsGateway implements EtimsGateway {
  static items: EtimsItem[] = [];
  static sales: EtimsSale[] = [];
  static failNext = 0;
  async initialize() {
    return { sdcId: 'KRACU0100000001', mrcNo: 'WIS00000001', cmcKey: 'MOCK-CMC-KEY', bhfNm: 'Simulated branch', taxprNm: 'Simulated taxpayer' };
  }
  async saveItem(item: EtimsItem) {
    MockEtimsGateway.items.push(item);
  }
  async saveSale(sale: EtimsSale) {
    if (MockEtimsGateway.failNext > 0) {
      MockEtimsGateway.failNext -= 1;
      throw new IntegrationError('Network error calling etims (simulated)');
    }
    MockEtimsGateway.sales.push(sale);
    const n = MockEtimsGateway.sales.length;
    return {
      curRcptNo: n, totRcptNo: n, sdcId: 'KRACU0100000001', mrcNo: 'WIS00000001',
      intrlData: `SIMINTRL${String(sale.invcNo).padStart(8, '0')}`, rcptSign: `SIMSIGN${String(sale.invcNo).padStart(9, '0')}`, sdcDateTime: sale.cfmDt,
    };
  }
}

/** yyyyMMddHHmmss / yyyyMMdd in East Africa Time. */
export function etimsDate(d: Date, withTime = true) {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}`;
  return withTime ? `${day}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}` : day;
}
