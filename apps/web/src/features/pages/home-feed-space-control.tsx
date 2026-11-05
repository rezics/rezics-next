import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { createHomeSpaceSelection } from './home-feed-spaces';

type Selection = ReturnType<typeof createHomeSpaceSelection>;
export function HomeFeedSpaceControl({
  selection,
  snapshot,
  locale,
  origin,
}: {
  selection: Selection;
  snapshot: ReturnType<Selection['snapshot']>;
  locale: string;
  origin: string;
}) {
  const id = useId();
  const [address, setAddress] = useState('');
  const options = { locale: locale as Locale };
  const busy = snapshot.status === 'loading';
  const failure = !['idle', 'ready', 'loading'].includes(snapshot.status);
  const messages = {
    invalid: m.home_space_invalid,
    unavailable: m.home_space_unavailable,
    denied: m.home_feed_denied,
    auth: m.home_feed_auth,
    closed: m.home_feed_closed,
  };
  return (
    <section
      className="space-y-3 [&_button]:min-h-11 [&_button]:whitespace-normal [&_input]:min-h-11"
      aria-label={m.home_space_label({}, options)}
      aria-busy={busy}
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void selection.lookup(address, origin);
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor={id}>{m.home_space_label({}, options)}</Label>
          <Input
            id={id}
            value={address}
            maxLength={2048}
            autoComplete="off"
            aria-describedby={`${id}-hint`}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy || !address}>
          {m.home_space_lookup({}, options)}
        </Button>
      </form>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {m.home_space_hint({}, options)}
      </p>
      {snapshot.selected ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 break-words">
            {m.home_space_selected({}, options)}: {snapshot.selected.title}
            {snapshot.selected.address ? ` /spaces/${snapshot.selected.address}` : ''}
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void selection.refresh()}>
            {m.home_space_refresh({}, options)}
          </Button>
          <Button variant="ghost" onClick={() => selection.clear()}>
            {m.home_space_clear({}, options)}
          </Button>
        </div>
      ) : null}
      {snapshot.candidate ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 break-words">
            {snapshot.candidate.title}
            {snapshot.candidate.address ? ` /spaces/${snapshot.candidate.address}` : ''}
          </p>
          <Button variant="secondary" onClick={() => selection.select()}>
            {m.home_space_select({}, options)}
          </Button>
        </div>
      ) : null}
      {busy ? <p role="status">{m.home_space_loading({}, options)}</p> : null}
      {failure ? (
        <div role="alert" className="space-y-2">
          <p>{messages[snapshot.status as keyof typeof messages]({}, options)}</p>
          {snapshot.status !== 'invalid' ? (
            <Button variant="outline" onClick={() => void selection.retry()}>
              {m.home_space_retry({}, options)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.changed ? <p role="status">{m.home_space_changed({}, options)}</p> : null}
    </section>
  );
}
