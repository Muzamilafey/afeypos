import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, newRequestId, openPrintable } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { date, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { ProductPicker } from '../../components/ProductPicker';
import { Button, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { EmailDocButton, PdfButton } from '../../components/DocumentActions';
import { getWorkstation } from '../../lib/workstation';

const TITLES: Record<string, string> = { quotation: 'Quotations', sales_order: 'Sales orders', delivery_note: 'Delivery notes' };

export function DocumentsPage() {
  const { type = 'quotation' } = useParams();
  const { me, can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const locs = useLocations();
  const list = useList(['documents', type], '/documents', { type, limit: 50 });
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState('');
  const [priceList, setPriceList] = useState(me!.capabilities.checkout.defaultPriceList);
  const [lines, setLines] = useState<{ productId: string; name: string; qty: number }[]>([]);
  const [error, setError] = useState<unknown>(null);

  const convert = (doc: any) => {
    // Load the document into a POS cart so the cashier takes payment (cash, M-Pesa, credit...).
    const tillId = getWorkstation().tillId;
    if (!tillId) {
      toast.info('Open Checkout once on this computer to choose its till first');
      return;
    }
    const key = `afey.carts.${tillId}`;
    try {
      const carts = JSON.parse(localStorage.getItem(key) ?? '[]');
      carts.push({ id: newRequestId(), label: doc.number, lines: doc.lines.map((l: any) => ({ key: newRequestId(), product: { _id: l.productId, name: l.name, sku: l.sku, baseUnit: l.unitCode, units: [{ code: l.unitCode, name: l.unitCode, factor: l.unitFactor ?? 1 }], prices: {}, taxRateBp: l.taxRateBp, trackSerials: false, trackBatches: false, allowFractional: true, requiresPrescription: false, ageRestricted: false }, unitCode: l.unitCode, qty: l.qty, unitPriceCents: l.unitPriceCents, quotedCents: l.unitPriceCents, discountCents: l.discountCents ?? 0, serials: [] })), customer: doc.customerId ? { _id: doc.customerId, name: doc.customerName } : null, priceList: doc.priceList, cartDiscountCents: 0, couponCode: '', ageVerified: false, salesDocumentId: doc._id });
      localStorage.setItem(key, JSON.stringify(carts));
      nav('/pos');
    } catch (e) { toast.error(e); }
  };

  return (
    <div>
      <PageHeader title={TITLES[type]} actions={type !== 'delivery_note' && can('quotations.manage') && <Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />New</Button>} />
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} columns={[
          { key: 'n', header: 'Number', render: (r: any) => r.number },
          { key: 'c', header: 'Customer', render: (r: any) => r.customerName ?? '—' },
          { key: 'd', header: 'Date', render: (r: any) => date(r.createdAt) },
          ...(type === 'quotation' ? [{ key: 'v', header: 'Valid until', render: (r: any) => date(r.validUntil) }] : []),
          ...(type !== 'delivery_note' ? [{ key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) }] : []),
          { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          { key: 'a', header: '', render: (r: any) => <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => openPrintable(`/documents/${r._id}/print`).catch(toast.error)}>Print</Button>
            <PdfButton kind="quotation" id={r._id} />
            {can('quotations.manage') && <EmailDocButton kind="quotation" id={r._id} defaultTo={r.customerEmail} what={TITLES[type]!.replace(/s$/, '')} onSent={() => r.status === 'draft' && api(`/documents/${r._id}/status`, { body: { status: 'sent' } }).then(() => qc.invalidateQueries({ queryKey: ['documents'] })).catch(() => undefined)} />}
            {type !== 'delivery_note' && ['draft', 'sent', 'accepted'].includes(r.status) && can('sales.create') && <Button size="sm" onClick={() => convert(r)}>Convert to sale</Button>}
            {type === 'sales_order' && !r.stockReserved && ['draft', 'sent', 'accepted'].includes(r.status) && <Button size="sm" variant="secondary" onClick={() => api(`/documents/${r._id}/reserve`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['documents'] })).catch(toast.error)}>Reserve stock</Button>}
            {type === 'delivery_note' && r.status === 'sent' && <Button size="sm" onClick={() => api(`/delivery-notes/${r._id}/delivered`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['documents'] })).catch(toast.error)}>Mark delivered</Button>}
          </div> },
        ]} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`New ${type.replace('_', ' ')}`} size="lg" footer={<Button disabled={!lines.length} onClick={async () => {
        try { await api('/documents', { body: { type, branchId: locs.data?.branches[0]._id, customerName: customer || undefined, priceList, lines: lines.map(({ productId, qty }) => ({ productId, qty })) } }); setOpen(false); setLines([]); qc.invalidateQueries({ queryKey: ['documents'] }); toast.success('Saved'); } catch (e) { setError(e); }
      }}>Save</Button>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="Customer name"><Input value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
          <Field label="Price list"><Select value={priceList} onChange={(e) => setPriceList(e.target.value as any)} options={me!.capabilities.priceLists.map((x) => ({ value: x, label: x }))} /></Field>
        </div>
        <ProductPicker onPick={(p) => setLines([...lines, { productId: p._id, name: p.name, qty: 1 }])} />
        <ul className="mt-2 space-y-2">{lines.map((l, i) => <li key={i} className="flex items-center gap-2 text-sm"><span className="flex-1">{l.name}</span><Input className="w-24" type="number" step="any" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} /></li>)}</ul>
        <p className="mt-2 text-xs text-ink-500">Prices are taken from the selected price list, quantity tiers and promotions when saved.</p>
        <ErrorBox error={error} />
      </Modal>
    </div>
  );
}
