import { useState } from 'react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input, Modal, useToast } from './ui';
import { Icon } from './icons';

/** Business documents the server renders as PDF (see server modules/documents). */
export type DocKind = 'supplier_quotation' | 'purchase_order' | 'goods_receipt' | 'quotation' | 'invoice';

/** Opens the document's PDF in a new tab (fetched with the signed-in session). */
export async function openPdf(kind: DocKind, id: string) {
  // Open the tab first so pop-up blockers allow it, then load the PDF into it.
  const w = window.open('', '_blank');
  try {
    const res = await api<Response>(`/pdf/${kind}/${id}`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    w?.close();
    throw e;
  }
}

export function PdfButton({ kind, id, label = 'PDF', size = 'sm' }: { kind: DocKind; id: string; label?: string; size?: 'sm' | 'md' }) {
  const toast = useToast();
  return <Button size={size} variant="secondary" onClick={() => openPdf(kind, id).catch(toast.error)}><Icon name="file" className="h-4 w-4" />{label}</Button>;
}

/** "Email" with a small form: recipient (defaults to the supplier or customer), copies and a message. The PDF is attached. */
export function EmailDocButton({ kind, id, defaultTo, label = 'Email', size = 'sm', what, onSent, send }: {
  kind: DocKind; id: string; defaultTo?: string | null; label?: string; size?: 'sm' | 'md'; what: string; onSent?: () => void;
  /** Custom send (e.g. the purchase order "send" that also marks it sent). */
  send?: (body: { to?: string; cc: string[]; message?: string }) => Promise<unknown>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(defaultTo ?? '');
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { to: to.trim() || undefined, cc: cc.split(/[,;\s]+/).filter(Boolean), message: message.trim() || undefined };
      const r: any = send ? await send(body) : await api(`/email/${kind}/${id}`, { body });
      const emailed = r?.emailed ?? r?.data;
      if (emailed && emailed.queued === false) throw new Error(`Not emailed: ${emailed.reason}`);
      toast.success(`${what} emailed to ${emailed?.to ?? to}`);
      setOpen(false);
      onSent?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" onClick={() => { setTo(defaultTo ?? ''); setOpen(true); }}><Icon name="mail" className="h-4 w-4" />{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Email ${what.toLowerCase()}`} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={submit}>Send email</Button></>}>
        <div className="space-y-3">
          <Field label="To" hint={defaultTo ? undefined : 'No email address on file: enter one'}><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="Copy to (optional)" hint="Separate several addresses with commas"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
          <Field label="Message (optional)"><textarea className="input" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Thank you for your business." /></Field>
          <p className="flex items-center gap-1.5 text-xs text-ink-500"><Icon name="file" className="h-3.5 w-3.5" />The {what.toLowerCase()} is attached as a PDF.</p>
          <ErrorBox error={error} />
        </div>
      </Modal>
    </>
  );
}
