'use client';

import { Button } from '@rezics/ui/button';
import { useEffect, useState } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';
import { pageSearchReady, type PageChoice, type PageSearchResult, type ZoneNavigationClient } from './api.ts';
import type { ZoneEditorMessages } from './messages.ts';

const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Work suggestions preserve the producer's failures and bounded continuation. */
export function PageSearchPicker({ query, picked, locale, copy, disabled, signInHref, api, onQueryChange, onChoose }: {
  query: string;
  picked: PageChoice | null;
  locale: string;
  copy: ZoneEditorMessages;
  disabled: boolean;
  signInHref: string;
  api: Pick<ZoneNavigationClient, 'findPages'>;
  onQueryChange(query: string): void;
  onChoose(choice: PageChoice): void;
}) {
  const [found, setFound] = useState<{ query: string; result: PageSearchResult } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if ((picked && query === picked.name) || !pageSearchReady(query)) {
      setFound(null);
      return;
    }
    let cancel = false;
    setFound(null);
    const timer = setTimeout(() => {
      void api.findPages(query, locale).then(result => {
        if (!cancel) setFound({ query, result });
      }).catch(() => {
        if (!cancel) setFound({ query, result: { ok: false, failure: 'unavailable' } });
      });
    }, 200);
    return () => { cancel = true; clearTimeout(timer); };
  }, [api, locale, picked, query, retry]);

  const answer = !picked && found?.query === query ? found.result : null;
  return <div className="grid max-w-md gap-2">
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{copy.addPage}</span>
      <input className={fieldClass} value={query} placeholder={copy.addPagePlaceholder} disabled={disabled}
        onChange={event => onQueryChange(event.target.value)} />
    </label>
    {answer && !answer.ok ? <div className="grid gap-2" role="alert">
      <p className="text-pretty text-sm">{answer.failure === 'partial' ? copy.pageSearchPartial
        : answer.failure === 'denied' ? copy.pageSearchDenied : copy.pageSearchUnavailable}</p>
      {answer.failure === 'sign-in' ? <LocalizedLink href={signInHref} className="text-sm underline">{copy.signInTitle}</LocalizedLink>
        : <Button variant="outline" size="sm" className="justify-self-start" disabled={disabled}
          onClick={() => setRetry(current => current + 1)}>{copy.tryAgain}</Button>}
    </div> : null}
    {answer?.ok && answer.data.choices.length === 0 && !answer.data.hasMore ?
      <p className="text-muted-foreground text-sm">{copy.noPageMatches}</p> : null}
    {answer?.ok && answer.data.hasMore ? <p className="text-pretty text-muted-foreground text-sm">{copy.pageSearchRefine}</p> : null}
    {answer?.ok && answer.data.choices.length ? <ul role="listbox" aria-label={copy.addPage}
      className="grid rounded-md border border-border/60">
      {answer.data.choices.map(choice => <li key={choice.target} role="presentation"><button type="button" role="option" aria-selected={false}
        className="w-full px-3 py-2 text-left text-sm hover:bg-accent" disabled={disabled}
        onClick={() => onChoose(choice)}>{choice.name}</button></li>)}
    </ul> : null}
  </div>;
}
