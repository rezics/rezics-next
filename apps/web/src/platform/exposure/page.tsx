import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import type { Action, ExposureQuery, ExposureReaderEnvelope, Intent, Outcome, Page } from './data';
import { ExposureOperation } from './operation';
import { useExposureVisit, type ExposureBoundIO } from './lifetime';

type StandaloneIO = {
  read(query?: ExposureQuery): Promise<Page>;
  change(intent: Intent, query?: ExposureQuery): Promise<Outcome>;
};
const actionLabel = (action: Action) => (action === 'open' ? m.exposure_open() : m.exposure_close());

type ViewProps = {
  page: Page;
  selection: ExposureQuery;
  intent: Intent | null;
  outcome: Outcome | null;
  busy: boolean;
  canReview: boolean;
  canSend: boolean;
  onReload(): void;
  onFirstPage(): void;
  onNextPage(): void;
  onReview(group: string, action: Action): void;
  onConfirm(): void;
  onCancel(): void;
};

function ExposureView({
  page,
  selection,
  intent,
  outcome,
  busy,
  canReview,
  canSend,
  onReload,
  onFirstPage,
  onNextPage,
  onReview,
  onConfirm,
  onCancel,
}: ViewProps) {
  const offered = page.status === 'ready' ? (['open', 'close'] as const).filter((action) => page.current.actions[action]) : [];
  const discovered = page.discovery.status === 'available' ? page.discovery.groups : [];
  const rows = page.status === 'ready'
    ? page.current.exposureGroups
    : discovered.slice(0, 20).map((group) => ({ group, open: undefined, at: undefined }));
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 pb-8">
      <header className="space-y-3">
        <PageHeading>{m.exposure_title()}</PageHeading>
        <p className="text-muted-foreground">{m.exposure_intro()}</p>
      </header>
      {page.status !== 'ready' && (
        <p role="status">{m.exposure_current_unavailable()}</p>
      )}
      <Button variant="outline" disabled={busy} onClick={onReload}>
        {m.exposure_reload()}
      </Button>
      {(selection.cursor || page.status === 'invalid-cursor') && (
        <Button variant="outline" disabled={busy} onClick={onFirstPage}>
          {m.exposure_first_page()}
        </Button>
      )}
      {page.discovery.status === 'unavailable' && <p role="status">{m.exposure_discovery_unavailable()}</p>}
      {page.status !== 'ready' ? (
        <>
          <p role="status">
            {page.status === 'signed-out'
              ? m.exposure_signed_out()
              : page.status === 'denied'
                ? m.exposure_denied()
                : page.status === 'invalid-cursor'
                  ? m.exposure_invalid_cursor()
                  : m.exposure_unavailable()}
          </p>
          {page.discovery.status === 'available' && (
            <section aria-labelledby="exposure-groups-heading" className="space-y-4">
              <h2 id="exposure-groups-heading" className="text-xl font-semibold">
                {m.exposure_groups()}
              </h2>
              <p className="text-muted-foreground">{m.exposure_partial_inventory()}</p>
              {discovered.length === 0 && <p>{m.exposure_no_visible_groups()}</p>}
              {rows.map(({ group }) => (
                <Card key={group}>
                  <CardHeader>
                    <CardTitle className="break-all">{group}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>{m.exposure_unknown()}</p>
                  </CardContent>
                </Card>
              ))}
            </section>
          )}
        </>
      ) : (
        <section aria-labelledby="exposure-groups-heading" className="space-y-4">
          <h2 id="exposure-groups-heading" className="text-xl font-semibold">
            {m.exposure_groups()}
          </h2>
          <p className="text-muted-foreground">{m.exposure_current_page()}</p>
          <div className="flex flex-wrap gap-3">
            {page.current.next && (
              <Button variant="outline" disabled={busy} onClick={onNextPage}>
                {m.exposure_next_page()}
              </Button>
            )}
          </div>
          {offered.length === 0 && <p>{m.exposure_actions_unavailable()}</p>}
          {page.current.exposureGroups.length === 0 && <p>{m.exposure_no_visible_groups()}</p>}
          {rows.map(({ group, open, at }) => (
            <Card key={group}>
              <CardHeader>
                <CardTitle className="break-all">{group}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p>
                  {open === undefined
                    ? m.exposure_unknown()
                    : open
                      ? m.exposure_state_open()
                      : m.exposure_state_closed()}
                </p>
                {at && (
                  <p>
                    {m.exposure_observed_at()} <time dateTime={at}>{at}</time>
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  {offered.map((action) => (
                    <Button
                      key={action}
                      variant="outline"
                      disabled={busy || !canReview || intent !== null}
                      aria-label={m.exposure_action_group({ action: actionLabel(action), group })}
                      onClick={() => onReview(group, action)}
                    >
                      {actionLabel(action)}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {intent && (
        <section aria-labelledby="exposure-confirm-heading" className="space-y-4 rounded-lg border p-5">
          <h2 id="exposure-confirm-heading" className="text-xl font-semibold">
            {m.exposure_confirm_title()}
          </h2>
          <p className="break-all font-semibold">
            {m.exposure_action_group({ action: actionLabel(intent.action), group: intent.group })}
          </p>
          <p>
            {intent.action === 'open'
              ? m.exposure_open_effect({ group: intent.group })
              : m.exposure_close_effect({ group: intent.group })}
          </p>
          {outcome === null && (
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy || !canSend} onClick={onConfirm}>
                {m.exposure_confirm()}
              </Button>
              <Button variant="outline" disabled={busy} onClick={onCancel}>
                {m.exposure_cancel()}
              </Button>
            </div>
          )}
          {outcome?.status === 'uncertain' && (
            <>
              <p>{m.exposure_keep_operation()}</p>
              <Button variant="outline" disabled={busy || !canSend} onClick={onConfirm}>
                {m.exposure_retry()}
              </Button>
            </>
          )}
        </section>
      )}
      {outcome && (
        <div role="status" aria-live="polite" className="space-y-2">
          <p>
            {outcome.status === 'recorded'
              ? m.exposure_recorded()
              : outcome.status === 'uncertain'
                ? m.exposure_uncertain()
                : m.exposure_not_sent()}
          </p>
          {outcome.status === 'recorded' && (
            <p>{outcome.receipt.changed ? m.exposure_changed() : m.exposure_unchanged()}</p>
          )}
        </div>
      )}
    </article>
  );
}

/** Compatibility surface for isolated Page/IO hosts without a fabricated session binding. */
export function PlatformExposurePage({ initial, io }: { initial: Page; io: StandaloneIO }) {
  const [page, setPage] = useState(initial);
  const [operation, setOperation] = useState(() => new ExposureOperation());
  const [, render] = useState(0);
  const [reading, setReading] = useState(false);
  const [selection, setSelection] = useState<ExposureQuery>({});
  const inFlight = useRef(false);
  const input = useRef(initial);
  const generation = useRef(0);

  if (input.current !== initial) {
    input.current = initial;
    generation.current++;
    inFlight.current = false;
    setPage(initial);
    setOperation(new ExposureOperation());
    setReading(false);
    setSelection({});
  }

  const intent = operation.intent;
  const outcome = operation.outcome;
  const busy = operation.busy || reading;
  const offered = page.status === 'ready' ? (['open', 'close'] as const).filter((action) => page.current.actions[action]) : [];
  const canReview = page.status === 'ready' && Object.values(page.current.actions).some(Boolean);
  const canSend =
    intent && page.status === 'ready' && hasGroup(page, intent.group) && offered.includes(intent.action) ? true : false;
  const update = () => render((value) => value + 1);

  async function read(query: ExposureQuery = selection) {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = generation.current;
    setReading(true);
    try {
      const result = await io.read(query);
      if (ticket === generation.current) {
        setSelection(query);
        setPage(result);
      }
    } catch {
      if (ticket === generation.current) setPage(unavailablePage());
    } finally {
      if (ticket === generation.current) {
        inFlight.current = false;
        setReading(false);
      }
    }
  }

  async function send() {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    const ticket = generation.current;
    const pending = operation.send((submitted) => io.change(submitted, selection));
    update();
    try {
      const result = await pending;
      if (ticket === generation.current && result) setPage(result.current);
    } finally {
      if (ticket === generation.current) {
        inFlight.current = false;
        update();
      }
    }
  }

  return (
    <ExposureView
      page={page}
      selection={selection}
      intent={intent}
      outcome={outcome}
      busy={busy}
      canReview={canReview}
      canSend={!!canSend}
      onReload={() => void read()}
      onFirstPage={() => void read({ limit: selection.limit ?? 20 })}
      onNextPage={() => {
        if (page.status === 'ready' && page.current.next)
          void read({ cursor: page.current.next, limit: selection.limit ?? 20 });
      }}
      onReview={(group, action) => {
        operation.review({ group, action, key: crypto.randomUUID(), body: {} });
        update();
      }}
      onConfirm={() => void send()}
      onCancel={() => {
        operation.cancel();
        update();
      }}
    />
  );
}

/** Route-only path: its initial page and every continuation carry a same-request reader binding. */
export function PlatformExposureBoundPage({ initial, io }: { initial: ExposureReaderEnvelope; io: ExposureBoundIO }) {
  const visit = useExposureVisit(initial, io);
  const page = visit.currentPage;
  return (
    <ExposureView
      page={page}
      selection={visit.selection}
      intent={visit.intent}
      outcome={visit.outcome}
      busy={visit.busy}
      canReview={visit.canReview}
      canSend={visit.canSend}
      onReload={() => void visit.read()}
      onFirstPage={() => void visit.read({ limit: visit.selection.limit ?? 20 })}
      onNextPage={() => {
        if (page.status === 'ready' && page.current.next)
          void visit.read({ cursor: page.current.next, limit: visit.selection.limit ?? 20 });
      }}
      onReview={(group, action) => visit.review(group, action)}
      onConfirm={() => void visit.send()}
      onCancel={() => visit.cancel()}
    />
  );
}

function hasGroup(page: Extract<Page, { status: 'ready' }>, group: string) {
  return page.current.exposureGroups.some((row) => row.group === group);
}

function unavailablePage(): Page {
  return { status: 'unavailable', discovery: { status: 'unavailable' } };
}
