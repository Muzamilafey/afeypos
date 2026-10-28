export interface TemplateDef {
  sms?: string;
  email?: { subject: string; body: string };
}

/** Built-in templates. Tenants can override them (NotificationTemplate). Variables use {{name}}. */
export const DEFAULT_TEMPLATES: Record<string, TemplateDef> = {
  paymentLink: {
    sms: '{{business}}: pay {{amount}} here: {{url}} (M-Pesa, Airtel Money or card). Ref {{reference}}',
    email: { subject: 'Pay {{amount}} to {{business}}', body: 'Hello,\n\nPay {{amount}} to {{business}} here: {{url}}\n\nReference {{reference}}.' },
  },
  receipt: {
    sms: '{{business}}: Receipt {{number}}. Total {{total}}. Paid {{paid}}. {{footer}}',
    email: { subject: 'Your receipt {{number}} from {{business}}', body: 'Hello {{customer}},\n\nThank you for your purchase.\n\n{{receiptText}}\n\n{{footer}}' },
  },
  payment_confirmation: {
    sms: '{{business}}: We have received {{amount}} ref {{reference}}. Balance {{balance}}. Thank you.',
    email: { subject: 'Payment received - {{business}}', body: 'Hello {{customer}},\n\nWe have received your payment of {{amount}} (ref {{reference}}).\nYour balance is {{balance}}.\n\nThank you.' },
  },
  customer_statement: {
    email: { subject: 'Account statement - {{business}}', body: 'Hello {{customer}},\n\nPlease find your statement below.\n\n{{statementText}}\n\nBalance due: {{balance}}' },
    sms: '{{business}}: Your account balance is {{balance}}. Thank you for your business.',
  },
  credit_reminder: {
    sms: '{{business}}: Dear {{customer}}, your balance of {{balance}} is overdue. Kindly arrange payment.',
    email: { subject: 'Payment reminder - {{business}}', body: 'Hello {{customer}},\n\nThis is a reminder that your balance of {{balance}} is overdue.\n\nThank you.' },
  },
  low_stock: {
    email: { subject: 'Low stock alert - {{business}}', body: 'The following products are at or below their reorder level:\n\n{{items}}' },
    sms: '{{business}}: {{count}} product(s) are low on stock: {{items}}',
  },
  purchase_order: {
    email: { subject: 'Purchase order {{number}} from {{business}}', body: 'Dear {{supplier}},\n\nPlease supply the following (the purchase order is attached as a PDF):\n\n{{items}}\n\nTotal: {{total}}\n\nRegards,\n{{business}}' },
  },
  /** Any business document sent with its PDF attached (quotation, invoice, request for quotation, GRN). */
  document: {
    email: { subject: '{{title}} {{number}} from {{business}}', body: 'Dear {{recipient}},\n\n{{message}}\n\nPlease find {{title}} {{number}} attached.{{amountLine}}\n\nRegards,\n{{sender}}\n{{business}}{{contact}}' },
  },
  supplier_rfq: {
    email: { subject: 'Request for quotation {{number}} from {{business}}', body: 'Dear {{recipient}},\n\n{{message}}\n\nPlease send us your best prices, availability and delivery time for the items in the attached request {{number}}{{replyBy}}.\n\nItems:\n{{items}}\n\nRegards,\n{{sender}}\n{{business}}{{contact}}' },
  },
  password_reset: {
    email: { subject: 'Reset your Afey POS password', body: 'Hello {{name}},\n\nUse this link to reset your password (valid for 30 minutes):\n{{link}}\n\nIf you did not request this, ignore this email.' },
  },
  email_verify: {
    email: { subject: 'Verify your Afey POS account', body: 'Hello {{name}},\n\nWelcome to Afey POS. Please verify your email address:\n{{link}}' },
  },
  scheduled_report: {
    email: { subject: '{{business}} - {{reportName}} ({{period}})', body: '{{reportText}}' },
  },
  order_new: {
    sms: '{{business}}: New online order {{number}} from {{customer}}, {{total}} ({{fulfilment}}).',
  },
  order_update: {
    sms: '{{business}}: Your order {{number}} {{statusText}} {{extra}}',
  },
  campaign: {
    sms: '{{business}}: {{message}} Reply STOP to opt out.',
    email: { subject: '{{subject}}', body: 'Hello {{customer}},\n\n{{message}}\n\n{{business}}\nTo stop these messages, reply "unsubscribe".' },
  },
  birthday: {
    sms: 'Happy birthday {{customer}}! {{business}} wishes you a wonderful day. {{offer}}',
    email: { subject: 'Happy birthday from {{business}}', body: 'Hello {{customer}},\n\nHappy birthday from all of us at {{business}}!\n\n{{offer}}' },
  },
  test: {
    sms: 'Afey POS test message from {{business}}.',
    email: { subject: 'Afey POS test email', body: 'This is a test email from {{business}}. Your email integration works.' },
  },
};

export function render(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (data[k] === undefined || data[k] === null ? '' : String(data[k])));
}
