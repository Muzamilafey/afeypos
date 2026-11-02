import { useState, type RefObject } from 'react';
import { downloadReportCsv, downloadReportPdf, downloadReportXlsx, extractReport, printReport } from '../lib/report';
import { Button, useToast } from './ui';
import { Icon } from './icons';

/** "PDF", "Excel", "CSV" and "Print" for the report shown in `target` (PDF and print on the business letterhead). */
export function ReportActions({ target, title, subtitle, meta, orientation, size = 'md', csv = true }: {
  target: RefObject<HTMLElement | null>; title: string; subtitle?: string; meta?: [string, string][]; orientation?: 'portrait' | 'landscape'; size?: 'sm' | 'md';
  /** False where the page already has its own (server) CSV download. */
  csv?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'pdf' | 'print' | 'xlsx' | 'csv' | null>(null);
  const run = async (what: 'pdf' | 'print' | 'xlsx' | 'csv') => {
    if (!target.current) return;
    setBusy(what);
    try {
      const spec = extractReport(target.current, { title, subtitle, meta, orientation });
      await (what === 'pdf' ? downloadReportPdf(spec) : what === 'xlsx' ? downloadReportXlsx(spec) : what === 'csv' ? downloadReportCsv(spec) : printReport(spec));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" loading={busy === 'pdf'} onClick={() => run('pdf')}><Icon name="download" className="h-4 w-4" />PDF</Button>
      <Button size={size} variant="secondary" loading={busy === 'xlsx'} onClick={() => run('xlsx')}><Icon name="download" className="h-4 w-4" />Excel</Button>
      {csv && <Button size={size} variant="secondary" loading={busy === 'csv'} onClick={() => run('csv')}><Icon name="download" className="h-4 w-4" />CSV</Button>}
      <Button size={size} variant="secondary" loading={busy === 'print'} onClick={() => run('print')}><Icon name="printer" className="h-4 w-4" />Print</Button>
    </>
  );
}
