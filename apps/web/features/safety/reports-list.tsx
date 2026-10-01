'use client';

import { Button } from '@rezics/ui/button';
import { TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { Notice } from '../discover/notice.tsx';
import { listReports } from './report-api.ts';
import { keyed, type ReportList, textFor } from './report.ts';

type Row = ReportList['reports'][number];

/**
 * The reports a signed-in reporter sent. Main keeps no way to reopen a case
 * without its private link, which it shows once, so the list says when and
 * what was reported and points back to that link.
 */
export function ReportsList({ locale, initial, send }: { locale: UiLocale; initial?: ReportList; send?: typeof fetch }) {
  const t = textFor(locale);
  const [rows, setRows] = useState<Row[] | null>(initial?.reports ?? null);
  const [cursor, setCursor] = useState<string | null>(initial?.nextCursor ?? null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (after: string | null) => {
    setBusy(true); setFailed(false);
    const result = await listReports(after, send);
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    setRows(current => [...(after ? current ?? [] : []), ...result.data.reports]);
    setCursor(result.data.nextCursor);
  };
  useEffect(() => { if (!initial) void load(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return <section aria-labelledby="mine-heading" className="grid max-w-2xl gap-3">
    <h2 id="mine-heading" className="font-semibold">{t.mineHeading}</h2>
    <p className="text-muted-foreground text-sm">{t.mineHelp}</p>
    {failed ? <Notice icon={TriangleAlertIcon} tone="destructive" title={t.mineFailed}>
      <Button variant="outline" size="sm" onClick={() => void load(null)}>{t.retry}</Button></Notice> : null}
    {rows?.length === 0 ? <p className="text-muted-foreground text-sm">{t.mineEmpty}</p> : null}
    <ul className="grid gap-2">{rows?.map(row => <li key={row.reportId}
      className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-xl bg-muted/60 px-4 py-3">
      <span className="font-medium">{keyed(t, 'cat', row.category, row.category)}</span>
      <span className="text-muted-foreground text-sm"><time dateTime={row.receivedAt}>{when.format(new Date(row.receivedAt))}</time>
        {' · '}{t.mineCase} {row.caseId.slice(0, 8)}</span>
    </li>)}</ul>
    {cursor ? <div><Button variant="outline" size="sm" onClick={() => void load(cursor)} isLoading={busy}
      disabled={busy}>{t.mineMore}</Button></div> : null}
  </section>;
}
