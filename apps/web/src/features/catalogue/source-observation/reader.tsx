import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type {
  SourceObservationInspection,
  SourceObservationItem,
  SourceObservationOutcome,
  SourceObservationProvider,
  SourceObservationRequest,
  SourceObservationInspect,
} from './contract';

type Failure = Exclude<SourceObservationOutcome, { kind: 'ready' }>;
type State =
  | { kind: 'loading'; request: SourceObservationRequest }
  | { kind: 'failure'; outcome: Failure; request: SourceObservationRequest }
  | {
      kind: 'ready';
      inspection: SourceObservationInspection;
      selected: SourceObservationItem | null;
      request: SourceObservationRequest;
    };
const controlClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function ObservationDetails({
  item,
  source,
  locale,
}: {
  item: SourceObservationItem;
  source: SourceObservationProvider;
  locale: string;
}) {
  const options = { locale: locale as never };
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  const payload = item.payload;
  const distributionLabel =
    'scale' in payload && payload.figures?.distribution
      ? m.source_observation_distribution(
          {
            completeness:
              payload.figures.distribution.completeness === 'complete'
                ? m.source_observation_complete({}, options)
                : m.source_observation_partial({}, options),
          },
          options,
        )
      : undefined;
  return (
    <div data-slot="source-observation-item" className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]">
      <dl className="grid min-w-0 gap-x-3 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-medium">{m.source_observation_provider({}, options)}</dt>
        <dd>{source === 'vndb' ? 'VNDB' : 'Bangumi'}</dd>
        <dt className="font-medium">{m.source_observation_alias({}, options)}</dt>
        <dd>{item.sourceAlias}</dd>
        <dt className="font-medium">{m.source_observation_record({}, options)}</dt>
        <dd>{item.sourceRecordId}</dd>
        <dt className="font-medium">{m.source_observation_as_of({ date: item.asOf }, options)}</dt>
        <dd>{item.asOf}</dd>
        <dt className="font-medium">{m.source_observation_digest({}, options)}</dt>
        <dd className="break-all font-mono text-xs">{item.digest}</dd>
        <dt className="font-medium">{m.source_observation_provenance({}, options)}</dt>
        <dd>{m.source_observation_unversioned({}, options)}</dd>
        <dt className="font-medium">
          {m.source_observation_payload_version({ version: item.payloadVersion }, options)}
        </dt>
        <dd>{item.legacy ? m.source_observation_legacy({}, options) : m.source_observation_immutable({}, options)}</dd>
        <dt className="font-medium">{m.source_observation_native_order({}, options)}</dt>
        <dd>
          {item.nativeOrder === null
            ? m.source_observation_legacy_order({}, options)
            : `${item.nativeOrder} · ${m.source_observation_native_order_note({}, options)}`}
        </dd>
      </dl>
      {!('scale' in payload) ? (
        <p role="status">{m.source_observation_cleared({}, options)}</p>
      ) : (
        <>
          <p>
            {m.source_observation_units({ min: number(payload.scale.min), max: number(payload.scale.max) }, options)}
          </p>
          <p>{m.source_observation_mean({ mean: number(payload.mean) }, options)}</p>
          <p>{m.source_observation_count({ count: number(payload.count) }, options)}</p>
          <p>{m.rating_import_licence({ licence: payload.licence }, options)}</p>
          <p>{m.source_observation_attribution({ attribution: payload.attribution }, options)}</p>
          {payload.figures?.distribution && (
            <div className="space-y-1">
              <p>{distributionLabel}</p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label={distributionLabel}>
                {payload.figures.distribution.bins.map((bin) => (
                  <li key={bin.score}>
                    {m.source_observation_bin({ score: number(bin.score), count: number(bin.count) }, options)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {payload.figures?.rank && (
            <p>
              {m.source_observation_rank({ position: number(payload.figures.rank.position) }, options)}
              {payload.figures.rank.population !== undefined &&
                ` · ${m.source_observation_population({ population: number(payload.figures.rank.population) }, options)}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function failureMessage(outcome: Failure, locale: string) {
  const options = { locale: locale as never };
  if (outcome.kind === 'denied') return m.sources_denied({}, options);
  if (outcome.kind === 'invalid') return m.sources_invalid({}, options);
  if (outcome.kind === 'conflict') return m.sources_conflict({}, options);
  return m.sources_unavailable({}, options);
}

/**
 * This reader holds at most the current head, one selected payload and one
 * native history page. Each request replaces that bounded snapshot; cursors
 * stay in component memory and are retried without changing their operands.
 */
export function SourceObservationReader({
  subjectId,
  source,
  digest,
  locale,
  sourcesHref,
  inspect,
}: {
  subjectId: string;
  source: SourceObservationProvider;
  digest: string;
  locale: string;
  sourcesHref: string;
  inspect: SourceObservationInspect;
}) {
  const titleId = useId();
  const initialRequest = useMemo<SourceObservationRequest>(
    () => ({ subjectId, source, digest }),
    [digest, source, subjectId],
  );
  const [state, setState] = useState<State>({ kind: 'loading', request: initialRequest });
  const generation = useRef(0);
  const run = useCallback(
    async (request: SourceObservationRequest) => {
      const attempt = ++generation.current;
      setState({ kind: 'loading', request });
      let outcome: SourceObservationOutcome;
      try {
        outcome = await inspect(request);
      } catch {
        outcome = { kind: 'unavailable' };
      }
      if (generation.current !== attempt) return;
      if (outcome.kind === 'ready') {
        setState({
          kind: 'ready',
          inspection: outcome.inspection,
          selected: request.digest === undefined ? null : (outcome.inspection.selectedObservation ?? null),
          request,
        });
      } else {
        setState({ kind: 'failure', outcome, request });
      }
    },
    [inspect],
  );

  useEffect(() => {
    void run(initialRequest);
    return () => {
      generation.current += 1;
    };
  }, [digest, initialRequest, run, source, subjectId]);

  const options = { locale: locale as never };
  const retry = () => {
    if (
      state.kind === 'failure' &&
      state.outcome.kind !== 'denied' &&
      state.outcome.kind !== 'missing' &&
      state.outcome.kind !== 'invalid'
    )
      void run(state.request);
  };
  const chooseHistory = (item: SourceObservationItem) => {
    setState((current) => (current.kind === 'ready' ? { ...current, selected: item } : current));
  };
  const loadHistory = () => {
    if (state.kind !== 'ready') return;
    const cursor = state.inspection.history?.nextCursor;
    void run(cursor ? { subjectId, source, cursor } : { subjectId, source, history: true });
  };

  return (
    <section
      data-slot="subject-source-observation"
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-lg border p-4 [overflow-wrap:anywhere] sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <h2 id={titleId} className="min-w-0 text-xl font-semibold">
          {m.source_observation_title({}, options)}
        </h2>
        <a className={linkClass} href={sourcesHref}>
          {m.source_observation_back({}, options)}
        </a>
      </div>
      {state.kind === 'loading' ? (
        <p role="status" aria-busy="true">
          {m.sources_loading({}, options)}
        </p>
      ) : state.kind === 'failure' ? (
        <div className="space-y-3">
          <p role="alert">{failureMessage(state.outcome, locale)}</p>
          {state.outcome.kind !== 'denied' &&
            state.outcome.kind !== 'missing' &&
            state.outcome.kind !== 'invalid' &&
            !(state.outcome.kind === 'unavailable' && state.outcome.capability) && (
              <Button className={controlClass} variant="outline" onClick={retry}>
                {m.sources_retry({}, options)}
              </Button>
            )}
        </div>
      ) : (
        <div className="min-w-0 space-y-5" data-slot="source-observation-snapshot">
          <section aria-labelledby={`${titleId}-current`} className="min-w-0 space-y-2">
            <h3 id={`${titleId}-current`} className="text-lg font-semibold">
              {m.source_observation_current({}, options)}
            </h3>
            {state.inspection.head.state === 'empty' ? (
              <p role="status">{m.source_observation_head_empty({}, options)}</p>
            ) : state.inspection.head.state === 'cleared' ? (
              <div className="space-y-2">
                <p role="status">{m.source_observation_head_cleared({}, options)}</p>
                {state.inspection.head.observation && (
                  <ObservationDetails item={state.inspection.head.observation} source={source} locale={locale} />
                )}
              </div>
            ) : state.inspection.head.observation ? (
              <ObservationDetails item={state.inspection.head.observation} source={source} locale={locale} />
            ) : null}
          </section>

          {state.selected && (
            <section aria-labelledby={`${titleId}-selected`} className="min-w-0 space-y-2">
              <h3 id={`${titleId}-selected`} className="text-lg font-semibold">
                {m.source_observation_selected({}, options)}
              </h3>
              <ObservationDetails item={state.selected} source={source} locale={locale} />
            </section>
          )}

          <section aria-labelledby={`${titleId}-history`} className="min-w-0 space-y-3">
            <h3 id={`${titleId}-history`} className="text-lg font-semibold">
              {m.source_observation_history({}, options)}
            </h3>
            {!state.inspection.history ? (
              <Button className={controlClass} variant="outline" onClick={loadHistory}>
                {m.source_observation_load_history({}, options)}
              </Button>
            ) : (
              <div className="space-y-3" data-slot="source-observation-history-page">
                {state.inspection.history.items.length === 0 ? (
                  <p role="status">
                    {state.inspection.history.nextCursor
                      ? m.source_observation_no_visible_item({}, options)
                      : m.source_observation_exhausted({}, options)}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {state.inspection.history.items.map((item) => (
                      <li key={item.digest} className="min-w-0">
                        <Button
                          className={controlClass}
                          variant={state.selected?.digest === item.digest ? 'default' : 'outline'}
                          aria-pressed={state.selected?.digest === item.digest}
                          onClick={() => chooseHistory(item)}
                        >
                          {m.source_observation_select({ record: item.sourceRecordId, date: item.asOf }, options)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {state.inspection.history.nextCursor ? (
                  <Button className={controlClass} variant="outline" onClick={loadHistory}>
                    {m.source_observation_continue({}, options)}
                  </Button>
                ) : (
                  state.inspection.history.items.length > 0 && (
                    <p role="status">{m.source_observation_exhausted({}, options)}</p>
                  )
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
