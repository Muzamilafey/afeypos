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
  /** API operator ("initiator") for Transaction Status and B2C, created on the M-Pesa org portal. */
  initiatorName?: string;
  /** Initiator password encrypted with Safaricom's certificate (generate it on the Daraja portal). */
  securityCredential?: string;
  /** B2C (bulk disbursement) short code used to pay salaries/refunds. */
  b2cShortCode?: string;
}

export interface TransactionStatusRequest {
  transactionId: string;
  resultUrl: string;
  timeoutUrl: string;
  originatorConversationId: string;
}

export interface B2CRequest {
  originatorConversationId: string;
  amount: number; // whole shillings
  phone: string; // 2547XXXXXXXX
  commandId: 'SalaryPayment' | 'BusinessPayment' | 'PromotionPayment';
  remarks: string;
  occasion?: string;
  resultUrl: string;
  timeoutUrl: string;
}

export interface AsyncAccepted {
  ConversationID?: string;
  OriginatorConversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  errorCode?: string;
  errorMessage?: string;
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

export interface C2BRegisterResponse {
  OriginatorCoversationID?: string;
  ConversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Plain-language reasons for the errors Safaricom returns when registering C2B URLs. */
export function explainC2BError(err: unknown, environment: 'sandbox' | 'production'): string {
  const body = (err as any)?.body ?? {};
  const code = String(body.errorCode ?? body.ResponseCode ?? '');
  const msg = String(body.errorMessage ?? body.ResponseDescription ?? (err as any)?.message ?? 'Registration failed');
  const status = (err as any)?.status;
  if (/already registered|duplicate/i.test(msg) || code === '500.003.1001') {
    return environment === 'production'
      ? 'Safaricom already has URLs registered for this short code. Live URLs can only be registered once: remove them on the Daraja portal (or ask apisupport@safaricom.co.ke), then register again.'
      : `Safaricom says the URLs are already registered (${msg}). Sandbox registrations can be repeated; try again in a minute.`;
  }
  if (status === 401 || /access token|unauthori[sz]ed|401/i.test(`${code} ${msg}`)) return `Safaricom refused the API keys (${msg}). Check the consumer key and secret, and that the Daraja app has the C2B product${environment === 'production' ? ' for this short code' : ''}.`;
  if (/shortcode|short code/i.test(msg)) return `Safaricom refused the short code (${msg}). Use your Paybill number, or for Buy Goods the store (head office) number. Sandbox uses its test short code, e.g. 600xxx.`;
  if (/url/i.test(msg)) return `Safaricom refused the callback URLs (${msg}). They must be public HTTPS addresses without words like "mpesa", "safaricom", "exe", "cmd", "sql" or "query".`;
  if (/network error|timeout/i.test(msg)) return `Safaricom could not be reached: ${msg}`;
  return `Safaricom: ${msg}${code ? ` (code ${code})` : ''}`;
}

export interface MpesaGateway {
  stkPush(req: StkPushRequest): Promise<StkPushResponse>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResponse>;
  registerC2BUrls(confirmationUrl: string, validationUrl: string, shortCode: string): Promise<C2BRegisterResponse>;
  /** Sandbox only: makes Safaricom send a test C2B payment to the registered URLs. */
  simulateC2B(req: { shortCode: string; amount: number; phone: string; billRef: string; buyGoods: boolean }): Promise<C2BRegisterResponse>;
  /** Asks Safaricom about a receipt (e.g. a code the customer shows); the answer arrives at resultUrl. */
  transactionStatus(req: TransactionStatusRequest): Promise<AsyncAccepted>;
  /** Sends money to a phone (salaries, refunds); the result arrives at resultUrl. */
  b2c(req: B2CRequest): Promise<AsyncAccepted>;
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
    // ResponseType "Completed": if the validation URL cannot be reached, Safaricom still completes the payment.
    const r = await this.post<C2BRegisterResponse>('/mpesa/c2b/v2/registerurl', { ShortCode: shortCode, ResponseType: 'Completed', ConfirmationURL: confirmationUrl, ValidationURL: validationUrl });
    if (r.errorCode || (r.ResponseCode && r.ResponseCode !== '0' && r.ResponseCode !== '00000000')) throw new IntegrationError(r.errorMessage ?? r.ResponseDescription ?? 'Registration failed', 200, r, false);
    return r;
  }

  async simulateC2B(req: { shortCode: string; amount: number; phone: string; billRef: string; buyGoods: boolean }) {
    if (this.cfg.environment !== 'sandbox') throw new IntegrationError('Test payments can only be simulated in the Daraja sandbox', undefined, undefined, false);
    return this.post<C2BRegisterResponse>('/mpesa/c2b/v1/simulate', {
      ShortCode: req.shortCode, CommandID: req.buyGoods ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline', Amount: req.amount, Msisdn: req.phone, BillRefNumber: req.buyGoods ? '' : req.billRef,
    });
  }

  private initiator() {
    if (!this.cfg.initiatorName || !this.cfg.securityCredential) throw new IntegrationError('Set the initiator name and security credential to use this M-Pesa feature', undefined, undefined, false);
    return { Initiator: this.cfg.initiatorName, SecurityCredential: this.cfg.securityCredential };
  }

  async transactionStatus(req: TransactionStatusRequest): Promise<AsyncAccepted> {
    const till = this.cfg.type === 'till';
    return this.post<AsyncAccepted>('/mpesa/transactionstatus/v1/query', {
      ...this.initiator(),
      CommandID: 'TransactionStatusQuery',
      TransactionID: req.transactionId,
      OriginatorConversationID: req.originatorConversationId,
      // Buy Goods payments are looked up on the till number (identifier type 2), Paybill on the short code (4).
      PartyA: till ? (this.cfg.tillNumber ?? this.cfg.shortCode) : this.cfg.shortCode,
      IdentifierType: till ? '2' : '4',
      ResultURL: req.resultUrl,
      QueueTimeOutURL: req.timeoutUrl,
      Remarks: 'Payment check',
      Occasion: 'POS',
    });
  }

  async b2c(req: B2CRequest): Promise<AsyncAccepted> {
    if (!Number.isInteger(req.amount) || req.amount < 10) throw new IntegrationError('M-Pesa payouts must be whole shillings of at least 10', undefined, undefined, false);
    if (!this.cfg.b2cShortCode) throw new IntegrationError('Set the B2C short code to send M-Pesa payouts', undefined, undefined, false);
    return this.post<AsyncAccepted>('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: req.originatorConversationId,
      InitiatorName: this.cfg.initiatorName,
      SecurityCredential: this.initiator().SecurityCredential,
      CommandID: req.commandId,
      Amount: req.amount,
      PartyA: this.cfg.b2cShortCode,
      PartyB: req.phone,
      Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: req.timeoutUrl,
      ResultURL: req.resultUrl,
      Occasion: (req.occasion ?? '').slice(0, 100),
    });
  }

  async testCredentials() {
    await this.token();
  }
}

/**
 * Offline simulator used in development and automated tests. It never moves money;
 * callbacks must be simulated explicitly (see /payments/mpesa/simulate in non-production).
 */
export class MockMpesaGateway implements MpesaGateway {
  static pushes: (StkPushRequest & { checkoutRequestId: string })[] = [];
  static statusQueries: TransactionStatusRequest[] = [];
  static payouts: B2CRequest[] = [];
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
  static registrations: Array<{ confirmationUrl: string; validationUrl: string; shortCode: string }> = [];
  async registerC2BUrls(confirmationUrl: string, validationUrl: string, shortCode: string) {
    MockMpesaGateway.registrations.push({ confirmationUrl, validationUrl, shortCode });
    return { ResponseCode: '0', ResponseDescription: 'Success (simulator)' };
  }
  async simulateC2B() {
    return { ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' };
  }
  async transactionStatus(req: TransactionStatusRequest): Promise<AsyncAccepted> {
    MockMpesaGateway.statusQueries.push(req);
    return { ResponseCode: '0', ConversationID: `AG_MOCK_${MockMpesaGateway.statusQueries.length}`, OriginatorConversationID: req.originatorConversationId, ResponseDescription: 'Accept the service request successfully.' };
  }
  async b2c(req: B2CRequest): Promise<AsyncAccepted> {
    MockMpesaGateway.payouts.push(req);
    return { ResponseCode: '0', ConversationID: `AG_MOCK_B2C_${MockMpesaGateway.payouts.length}`, OriginatorConversationID: req.originatorConversationId, ResponseDescription: 'Accept the service request successfully.' };
  }
  async testCredentials() {}
}

/** Async Result callback body shared by Transaction Status, B2C and reversals. */
export function parseAsyncResult(body: any) {
  const r = body?.Result;
  if (!r || r.ResultCode === undefined) return null;
  const params = new Map<string, unknown>((r.ResultParameters?.ResultParameter ?? []).map((p: { Key: string; Value: unknown }) => [p.Key, p.Value]));
  return {
    resultCode: Number(r.ResultCode),
    resultDesc: String(r.ResultDesc ?? ''),
    conversationId: r.ConversationID ? String(r.ConversationID) : undefined,
    originatorConversationId: r.OriginatorConversationID ? String(r.OriginatorConversationID) : undefined,
    transactionId: r.TransactionID ? String(r.TransactionID) : undefined,
    params,
  };
}

/** "254712345678 - JOHN DOE" -> { phone, name } */
export function splitParty(v: unknown): { phone?: string; name?: string } {
  const m = /^\s*(\d{9,15})\s*-\s*(.+)$/.exec(String(v ?? ''));
  return m ? { phone: m[1], name: m[2].trim() } : { name: v ? String(v) : undefined };
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
