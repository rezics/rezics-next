'use client';

import { Button } from '@rezics/ui/button';
import { useRef, useState } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';
import { browserZoneCollectionLookup, type PageChoice, type WriteResult, type ZoneCollectionLookupClient } from './api.ts';
import type { ZoneEditorMessages } from './messages.ts';

const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Collection names are resolved from their resource link independently of Work title suggestions. */
export function CollectionPageLookup({ actingSubject, copy, disabled, signInHref, onChoose, api }: {
  actingSubject: string;
  copy: ZoneEditorMessages;
  disabled: boolean;
  signInHref: string;
  onChoose(choice: PageChoice): void;
  api?: ZoneCollectionLookupClient;
}) {
  const [resourceLink, setResourceLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<WriteResult<PageChoice> | null>(null);
  const latest = useRef(0);
  const client = useRef<ZoneCollectionLookupClient | null>(null);
  client.current ??= api ?? browserZoneCollectionLookup();

  async function find() {
    const seq = ++latest.current;
    setBusy(true);
    setAnswer(null);
    try {
      const found = await client.current!.findCollection(resourceLink, actingSubject);
      if (seq === latest.current) setAnswer(found);
    } catch {
      if (seq === latest.current) setAnswer({ ok: false, failure: 'unavailable' });
    } finally {
      if (seq === latest.current) setBusy(false);
    }
  }

  return <div className="grid max-w-md gap-2">
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{copy.collectionLink}</span>
      <input className={fieldClass} value={resourceLink}
        autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled}
        onChange={event => {
          latest.current += 1;
          setBusy(false);
          setAnswer(null);
          setResourceLink(event.target.value);
        }} />
    </label>
    <Button size="sm" variant="outline" className="justify-self-start" disabled={disabled || busy || !resourceLink.trim()}
      isLoading={busy} onClick={() => void find()}>{copy.collectionFind}</Button>
    {answer && !answer.ok ? <div className="grid gap-2" role="alert">
      <p className="text-pretty text-sm">{answer.failure === 'invalid' ? copy.collectionInvalidLink : copy.collectionUnavailable}</p>
      {answer.failure === 'sign-in' ? <LocalizedLink href={signInHref} className="text-sm underline">{copy.signInTitle}</LocalizedLink>
        : answer.failure === 'unavailable' ? <Button size="sm" variant="outline" className="justify-self-start"
          disabled={disabled || busy} onClick={() => void find()}>{copy.tryAgain}</Button> : null}
    </div> : null}
    {answer?.ok ? <ul role="listbox" aria-label={copy.collectionFind} className="grid rounded-md border border-border/60">
      <li role="presentation"><button type="button" role="option" aria-selected={false} disabled={disabled}
        className="w-full px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => {
          onChoose(answer.data);
          setAnswer(null);
        }}>{answer.data.name}</button></li>
    </ul> : null}
  </div>;
}
