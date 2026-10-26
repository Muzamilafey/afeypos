/** Receipt layout chosen in Settings > Receipts: template, paper, what to show and extra lines. */

export const RECEIPT_TEMPLATES = ['classic', 'modern', 'compact', 'bold', 'elegant'] as const;
export type ReceiptTemplate = (typeof RECEIPT_TEMPLATES)[number];

export const RECEIPT_TEMPLATE_INFO: Record<ReceiptTemplate, { label: string; description: string }> = {
  classic: { label: 'Classic', description: 'Traditional till slip: centred header, dashed rules, monospace figures.' },
  modern: { label: 'Modern', description: 'Clean sans-serif layout with a framed total and item table.' },
  compact: { label: 'Compact', description: 'One line per item and tight spacing: saves paper on busy tills.' },
  bold: { label: 'Bold', description: 'Large business name and a solid black total bar that stands out.' },
  elegant: { label: 'Elegant', description: 'Serif headings, generous spacing and a decorative divider.' },
};

export interface ReceiptCustomField {
  label: string;
  value: string;
  position: 'top' | 'bottom';
}

export interface ReceiptShow {
  logo: boolean;
  tagline: boolean;
  address: boolean;
  phone: boolean;
  email: boolean;
  taxPin: boolean;
  cashier: boolean;
  till: boolean;
  branch: boolean;
  customer: boolean;
  sku: boolean;
  unitPrice: boolean;
  itemCount: boolean;
  taxSummary: boolean;
  savings: boolean;
  loyalty: boolean;
  barcode: boolean;
  qr: boolean;
  poweredBy: boolean;
}

export interface ReceiptSettings {
  template: ReceiptTemplate;
  paper: '80mm' | '58mm';
  fontSize: 'small' | 'normal' | 'large';
  /** Heading above the receipt details, e.g. "SALES RECEIPT", "CASH SALE". Empty hides it. */
  title: string;
  show: ReceiptShow;
  /** Extra label: value lines, e.g. "Paybill: 123456", "Website: myshop.co.ke". */
  customFields: ReceiptCustomField[];
  /** Promotion or announcement printed above the footer. */
  message: string;
  returnPolicy: string;
}

export const RECEIPT_DEFAULTS: ReceiptSettings = {
  template: 'classic',
  paper: '80mm',
  fontSize: 'normal',
  title: 'SALES RECEIPT',
  show: {
    logo: true, tagline: true, address: true, phone: true, email: false, taxPin: true,
    cashier: true, till: true, branch: false, customer: true,
    sku: false, unitPrice: true, itemCount: true, taxSummary: true, savings: true, loyalty: true,
    barcode: true, qr: true, poweredBy: true,
  },
  customFields: [],
  message: '',
  returnPolicy: '',
};

/** Characters per line on the thermal printer for the paper width. */
export const RECEIPT_WIDTH_CHARS: Record<ReceiptSettings['paper'], number> = { '80mm': 42, '58mm': 32 };

/** Saved settings over the defaults; unknown or invalid values fall back. */
export function mergeReceipt(saved: unknown): ReceiptSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<ReceiptSettings>;
  const show = { ...RECEIPT_DEFAULTS.show };
  for (const k of Object.keys(show) as (keyof ReceiptShow)[]) if (typeof s.show?.[k] === 'boolean') show[k] = s.show[k];
  return {
    template: RECEIPT_TEMPLATES.includes(s.template as ReceiptTemplate) ? (s.template as ReceiptTemplate) : RECEIPT_DEFAULTS.template,
    paper: s.paper === '58mm' ? '58mm' : '80mm',
    fontSize: s.fontSize === 'small' || s.fontSize === 'large' ? s.fontSize : 'normal',
    title: typeof s.title === 'string' ? s.title : RECEIPT_DEFAULTS.title,
    show,
    customFields: Array.isArray(s.customFields)
      ? s.customFields.filter((f) => f && typeof f.label === 'string').map((f) => ({ label: f.label, value: String(f.value ?? ''), position: f.position === 'top' ? 'top' : 'bottom' }))
      : [],
    message: typeof s.message === 'string' ? s.message : '',
    returnPolicy: typeof s.returnPolicy === 'string' ? s.returnPolicy : '',
  };
}
