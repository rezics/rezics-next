import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { parseIntent, type Action, type Intent, type Outcome, type Page } from './data';
import { ExposureOperation } from './operation';

type IO = { read(): Promise<Page>; change(intent: Intent): Promise<Outcome> };
const actionLabel = (action: Action) => action === 'open' ? m.exposure_open() : m.exposure_close();

export function PlatformExposurePage({ initial, io }: { initial: Page; io: IO }) {
  const [page, setPage] = useState(initial);
  const [operation] = useState(() => new ExposureOperation());
  const [, render] = useState(0);
  const [reading, setReading] = useState(false);
  const inFlight = useRef(false);
  const intent = operation.intent;
  const outcome = operation.outcome;
  const busy = operation.busy || reading;
  const offered = page.status === 'ready' && page.authority.status === 'available' ? page.authority.offered : [];
  const canSend = intent && page.status === 'ready' && page.groups.includes(intent.group) && offered.includes(intent.action);
  const update = () => render((value) => value + 1);

  async function read() {
    if (inFlight.current) return;
    inFlight.current = true;
    setReading(true);
    try { setPage(await io.read()); }
    catch { setPage({ status: 'unavailable' }); }
    finally { inFlight.current = false; setReading(false); }
  }
  async function send() {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    const pending = operation.send(io.change);
    update();
    try {
      const result = await pending;
      if (result) setPage(result.current);
    } finally { inFlight.current = false; update(); }
  }

  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 pb-8">
      <header className="space-y-3">
        <PageHeading>{m.exposure_title()}</PageHeading>
        <p className="text-muted-foreground">{m.exposure_intro()}</p>
      </header>
      <p role="status">{m.exposure_current_unavailable()}</p>
      <Button variant="outline" disabled={busy} onClick={() => void read()}>{m.exposure_reload()}</Button>
      {page.status !== 'ready' ? (
        <p role="status">{page.status === 'signed-out' ? m.exposure_signed_out() :
          page.status === 'denied' ? m.exposure_denied() : m.exposure_unavailable()}</p>
      ) : (
        <section aria-labelledby="exposure-groups-heading" className="space-y-4">
          <h2 id="exposure-groups-heading" className="text-xl font-semibold">{m.exposure_groups()}</h2>
          <p className="text-muted-foreground">{m.exposure_partial_inventory()}</p>
          {offered.length === 0 && <p>{m.exposure_actions_unavailable()}</p>}
          {page.groups.length === 0 && <p>{m.exposure_no_visible_groups()}</p>}
          {page.groups.map((group) => (
            <Card key={group}>
              <CardHeader><CardTitle className="break-all">{group}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p>{m.exposure_unknown()}</p>
                <div className="flex flex-wrap gap-3">
                  {offered.map((action) => (
                    <Button key={action} variant="outline" disabled={busy || intent !== null}
                      aria-label={m.exposure_action_group({ action: actionLabel(action), group })}
                      onClick={() => {
                        operation.review(parseIntent({ group, action, key: crypto.randomUUID(), body: {} }));
                        update();
                      }}>{actionLabel(action)}</Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {intent && (
        <section aria-labelledby="exposure-confirm-heading" className="space-y-4 rounded-lg border p-5">
          <h2 id="exposure-confirm-heading" className="text-xl font-semibold">{m.exposure_confirm_title()}</h2>
          <p className="break-all font-semibold">{m.exposure_action_group({ action: actionLabel(intent.action), group: intent.group })}</p>
          <p>{intent.action === 'open' ? m.exposure_open_effect({ group: intent.group }) : m.exposure_close_effect({ group: intent.group })}</p>
          {outcome === null && <div className="flex flex-wrap gap-3">
            <Button disabled={busy || !canSend} onClick={() => void send()}>{m.exposure_confirm()}</Button>
            <Button variant="outline" disabled={busy} onClick={() => { operation.cancel(); update(); }}>{m.exposure_cancel()}</Button>
          </div>}
          {outcome?.status === 'uncertain' && <>
            <p>{m.exposure_keep_operation()}</p>
            <Button variant="outline" disabled={busy || !canSend} onClick={() => void send()}>{m.exposure_retry()}</Button>
          </>}
        </section>
      )}
      {outcome && <div role="status" aria-live="polite" className="space-y-2">
        <p>{outcome.status === 'recorded' ? m.exposure_recorded() :
          outcome.status === 'uncertain' ? m.exposure_uncertain() : m.exposure_not_sent()}</p>
        {outcome.status === 'recorded' && <p>{outcome.receipt.changed ? m.exposure_changed() : m.exposure_unchanged()}</p>}
      </div>}
    </article>
  );
}
