/**
 * Safaricom Daraja API client (M-Pesa Express / STK Push, STK query, C2B URL registration).
 * Credentials are server-side only and supplied per integration configuration.
 */
import { httpJson, IntegrationError } from '../http.js';

export interface DarajaConfig {
  environment: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  /** Business short code used to sign STK requests (PayBill number, or Head Office number for Till). */
  shortCode: string;
  passkey: string;
  /** 'paybill' => CustomerPayBillOnline, 'till' => CustomerBuyGoodsOnline */
  type: 'paybill' | 'till';
  /** Till number receiving funds when type = till (PartyB). Defaults to shortCode. */
  tillNumber?: string;
}

export interface StkPushRequest {
  amount: number; // whole shillings
  phone: string; // 2547XXXXXXXX
  accountReference: string;
  description: string;
  callbackUrl: string;
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResultCode?: string | number;
  ResultDesc?: string;
  CheckoutRequestID?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MpesaGateway {
  stkPush(req: StkPushRequest): Promise<StkPushResponse>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResponse>;
  registerC2BUrls(confirmationUrl: string, validationUrl: string, shortCode: string): Promise<unknown>;
  testCredentials(): Promise<void>;
}

export function darajaTimestamp(d = new Date()): string {
  // Daraja expects EAT (UTC+3) local time YYYYMMDDHHmmss.
  const eat = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export function stkPassword(shortCode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export class DarajaClient implements MpesaGateway {
  constructor(private cfg: DarajaConfig) {}

  get baseUrl() {
    return this.cfg.environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  }

  private async token(): Promise<string> {
    const cacheKey = `${this.cfg.environment}:${this.cfg.consumerKey}`;
    const c = tokenCache.get(cacheKey);
    if (c && c.expiresAt > Date.now() + 30_000) return c.token;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await httpJson<{ access_token: string; expires_in: string }>(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.access_token) throw new IntegrationError('Daraja did not return an access token', undefined, res, false);
    tokenCache.set(cacheKey, { token: res.access_token, expiresAt: Date.now() + Number(res.expires_in ?? 3599) * 1000 });
    return res.access_token;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.token();
    return httpJson<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    if (!Number.isInteger(req.amount) || req.amount < 1) throw new IntegrationError('M-Pesa amounts must be whole shillings of at least 1', undefined, undefined, false);
    const ts = darajaTimestamp();
    return this.post<StkPushResponse>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortCode,
      Password: stkPassword(this.cfg.shortCode, this.cfg.passkey, ts),
      Timestamp: ts,
      TransactionType: this.cfg.type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: req.amount,
      PartyA: req.phone,
      PartyB: this.cfg.type === 'till' ? (this.cfg.tillNumber ?? this.cfg.shortCode) : this.cfg.shortCode,
      PhoneNumber: req.phone,
      CallBackURL: req.callbackUrl,
      AccountReference: req.accountReference.slice(0, 12),
      TransactionDesc: req.description.slice(0, 13),
    });
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
    const ts = darajaTimestamp();
    try {
      return await this.post<StkQueryResponse>('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: this.cfg.shortCode,
        Password: stkPassword(this.cfg.shortCode, this.cfg.passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      });
    } catch (err) {
      // "The transaction is being processed" is returned as HTTP 500 with errorCode 500.001.1001.
      if (err instanceof IntegrationError && (err.body as any)?.errorCode) return err.body as StkQueryResponse;
      throw err;
    }
  }

  async registerC2BUrls(confirmationUrl: string, validationUrl: string, shortCode: string) {
    return this.post('/mpesa/c2b/v2/registerurl', { ShortCode: shortCode, ResponseType: 'Completed', ConfirmationURL: confirmationUrl, ValidationURL: validationUrl });
  }

  async testCredentials() {
    await this.token();
  }
}

/**
 * Offline simulator used in development and automated tests. It never moves money;
 * callbacks must be simulated explicitly (see /integrations/mpesa/simulate in non-production).
 */
export class MockMpesaGateway implements MpesaGateway {
  static pushes: (StkPushRequest & { checkoutRequestId: string })[] = [];
  static queryResults = new Map<string, StkQueryResponse>();
  private static seq = 0;
  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    MockMpesaGateway.seq += 1;
    const id = `ws_CO_MOCK_${Date.now()}_${MockMpesaGateway.seq}`;
    MockMpesaGateway.pushes.push({ ...req, checkoutRequestId: id });
    return { MerchantRequestID: `mock-${MockMpesaGateway.seq}`, CheckoutRequestID: id, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success. Request accepted for processing' };
  }
  async stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
    return MockMpesaGateway.queryResults.get(checkoutRequestId) ?? { ResponseCode: '500.001.1001', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' };
  }
  async registerC2BUrls() {
    return { ResponseDescription: 'success (mock)' };
  }
  async testCredentials() {}
}

export interface StkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] };
    };
  };
}

export function parseStkCallback(body: StkCallbackBody) {
  const cb = body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID || cb.ResultCode === undefined) return null;
  const items = new Map((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
  const rawDate = items.get('TransactionDate');
  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc,
    amount: items.has('Amount') ? Number(items.get('Amount')) : undefined,
    receiptNumber: items.get('MpesaReceiptNumber') ? String(items.get('MpesaReceiptNumber')) : undefined,
    phone: items.get('PhoneNumber') ? String(items.get('PhoneNumber')) : undefined,
    transactionDate: rawDate ? parseDarajaDate(String(rawDate)) : undefined,
  };
}

/** Parses YYYYMMDDHHmmss in EAT. */
export function parseDarajaDate(s: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]));
}

/** Result codes that mean the customer did not pay (cancelled / timeout / insufficient funds...). */
export function stkResultToStatus(code: number): 'succeeded' | 'cancelled' | 'failed' | 'expired' {
  if (code === 0) return 'succeeded';
  if (code === 1032) return 'cancelled';
  if (code === 1037 || code === 1019) return 'expired';
  return 'failed';
}
