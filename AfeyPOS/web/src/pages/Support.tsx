import { useAuth } from '../lib/auth';
import { Card, PageHeader } from '../components/ui';

const GUIDES: [string, string][] = [
  ['Checkout and receipts', 'Scan or search products, take cash, M-Pesa or card, print or SMS the receipt.'],
  ['Returns', 'Orders → Returns: scan the receipt, choose items, refund. A supervisor approves when needed.'],
  ['Stock', 'Inventory: receive goods, adjust, transfer between branches and count stock.'],
  ['M-Pesa and KRA eTIMS', 'Settings → Integrations: connect Daraja (Paybill or Till) and your eTIMS device.'],
  ['Staff cards and fingerprints', 'Settings → Users: issue cards, set PINs and enrol fingerprints.'],
  ['Payroll', 'People → Payroll: PAYE, SHIF, NSSF and Housing Levy are calculated for you.'],
  ['Online shop', 'Settings → Online shop and Store studio: open the shop, brand it and choose how customers pay.'],
];

export function SupportPage() {
  const { me } = useAuth();
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Support" subtitle="Help with Afey POS" />
      <div className="grid gap-4 md:grid-cols-2">
        {GUIDES.map(([t, d]) => <Card key={t} title={t}><p className="text-sm text-ink-600 dark:text-ink-300">{d}</p></Card>)}
      </div>
      <Card title="Your installation">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-ink-500">Business</dt><dd>{me!.tenant.name}</dd>
          <dt className="text-ink-500">Server</dt><dd>{me!.deploymentMode === 'hq' ? 'Head office' : me!.deploymentMode === 'branch' ? 'Branch server' : 'Single shop'}</dd>
          <dt className="text-ink-500">Signed in as</dt><dd>{me!.user.email}</dd>
        </dl>
        <p className="mt-3 text-sm text-ink-500">The full guides are in the <code>docs</code> folder of your installation (README, MPESA, ETIMS, HR, ACCOUNTING, ONLINE-SHOP, TROUBLESHOOTING).</p>
      </Card>
    </div>
  );
}
