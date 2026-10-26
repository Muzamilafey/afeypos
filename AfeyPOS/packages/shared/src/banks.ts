/**
 * Banks in Kenya whose cards (and card machines) the till records, plus the card networks accepted on
 * Kenyan card machines. Any Visa, Mastercard, UnionPay, Amex, Diners, JCB or Discover card works on a
 * bank's machine regardless of the issuing bank; the list is for reconciliation and reports.
 */
export const KENYA_BANKS = [
  'Absa Bank Kenya', 'Access Bank Kenya', 'African Banking Corporation (ABC)', 'Bank of Africa Kenya', 'Bank of Baroda', 'Bank of India',
  'Citibank', 'Consolidated Bank', 'Co-operative Bank', 'Credit Bank', 'Development Bank of Kenya', 'Diamond Trust Bank (DTB)',
  'Dubai Islamic Bank Kenya', 'Ecobank Kenya', 'Equity Bank', 'Family Bank', 'Guaranty Trust Bank', 'Gulf African Bank',
  'Habib Bank AG Zurich', 'HFC (HF Group)', 'I&M Bank', 'KCB Bank', 'Kingdom Bank', 'Mayfair CIB Bank', 'Middle East Bank',
  'M-Oriental Bank', 'National Bank of Kenya', 'NCBA Bank', 'Paramount Bank', 'Postbank', 'Premier Bank Kenya', 'Prime Bank',
  'SBM Bank Kenya', 'Sidian Bank', 'Spire Bank', 'Stanbic Bank', 'Standard Chartered', 'UBA Kenya', 'Victoria Commercial Bank',
  'SACCO card', 'Foreign bank card',
] as const;

export const CARD_NETWORKS = ['Visa', 'Mastercard', 'UnionPay', 'American Express', 'Diners Club', 'JCB', 'Discover'] as const;
