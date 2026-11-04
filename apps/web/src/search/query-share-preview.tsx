import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { locales } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { queryShareUrl, shareUnavailable, type QueryShare } from './query-share';

export function QuerySharePreview({ locale, changed, prepare }: {
  locale: string; changed: boolean; prepare: () => Promise<QueryShare>;
}) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<QueryShare>();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'refused'>('idle');
  const alive = useRef(true);
  const command = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; command.current++; }; }, []);
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  useEffect(() => { if (copy === 'refused') { link.current?.focus(); link.current?.select(); } }, [copy]);
  const options = { locale: locales.find((entry) => entry === locale) ?? 'en' };
  const url = share && typeof window !== 'undefined' ? queryShareUrl(window.location.origin, locale, share) : null;
  const close = () => { command.current++; setOpen(false); setShare(undefined); setCopy('idle'); trigger.current?.focus(); };
  return <div className="space-y-3">
    <Button ref={trigger} type="button" variant="outline" onClick={async () => {
      const generation = ++command.current;
      setOpen(true); setShare(undefined); setCopy('idle');
      let next: QueryShare;
      try { next = await prepare(); } catch { next = shareUnavailable(); }
      if (alive.current && generation === command.current) setShare(next);
    }}>{m.search_share_action({}, options)}</Button>
    {open && <div ref={panel} role="region" aria-label={m.search_share_action({}, options)} tabIndex={-1}
      className="space-y-3 rounded-xl border p-4" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
      <p>{changed ? m.search_share_draft({}, options) : m.search_share_executed({}, options)}</p>
      {!share ? <p role="status">{m.search_share_loading({}, options)}</p> : <>
        {share.document && <>
          <p className="whitespace-pre-wrap break-words">{share.document.text}</p>
          <p>{share.document.languages.join(' → ')}</p>
          {share.document.sort && <p>{share.document.sort}</p>}
          <ul>{share.selections.map((label, index) => <li key={index} lang={label.language}>{label.value}</li>)}</ul>
          {share.document.filter && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{share.document.filter}</pre>}
        </>}
        {url ? <>
          <Button type="button" onClick={async () => {
            const generation = command.current;
            try {
              await navigator.clipboard.writeText(url);
              if (alive.current && generation === command.current) setCopy('copied');
            } catch { if (alive.current && generation === command.current) setCopy('refused'); }
          }}>{m.search_share_copy({}, options)}</Button>
          {copy === 'copied' && <p role="status">{m.search_share_copied({}, options)}</p>}
          {copy === 'refused' && <>
            <p role="status">{m.search_share_refused({}, options)}</p>
            <textarea ref={link} aria-label={m.search_share_copy({}, options)} readOnly value={url} className="w-full" onFocus={(event) => event.currentTarget.select()} />
          </>}
        </> : <p role="status">{share.reason === 'oversized' || share.action === 'allowed' ? m.search_share_oversized({}, options) : share.reason === 'private_context' ? m.search_share_private({}, options) : m.search_share_unavailable({}, options)}</p>}
      </>}
      <Button type="button" variant="outline" onClick={close}>{m.search_share_close({}, options)}</Button>
    </div>}
  </div>;
}
