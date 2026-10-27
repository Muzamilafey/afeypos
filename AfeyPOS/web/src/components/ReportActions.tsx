import { useState, type RefObject } from 'react';
import { downloadReportPdf, extractReport, printReport } from '../lib/report';
import { Button, useToast } from './ui';
import { Icon } from './icons';

/** "PDF" and "Print" for the report shown in `target`, on the business letterhead. */
export function ReportActions({ target, title, subtitle, meta, orientation, size = 'md' }: {
  target: RefObject<HTMLElement | null>; title: string; subtitle?: string; meta?: [string, string][]; orientation?: 'portrait' | 'landscape'; size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const run = async (what: 'pdf' | 'print') => {
    if (!target.current) return;
    setBusy(what);
    try {
      const spec = extractReport(target.current, { title, subtitle, meta, orientation });
      await (what === 'pdf' ? downloadReportPdf(spec) : printReport(spec));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" loading={busy === 'pdf'} onClick={() => run('pdf')}><Icon name="download" className="h-4 w-4" />PDF</Button>
      <Button size={size} variant="secondary" loading={busy === 'print'} onClick={() => run('print')}><Icon name="printer" className="h-4 w-4" />Print</Button>
    </>
  );
}
