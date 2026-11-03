import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { classificationPair, indexOwnClassifications } from './inventory';
import type {
  ClassificationFrontier,
  OwnClassification,
  OwnClassificationsPage,
  OwnClassificationsState,
} from './types';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2';

/** Source-contract projection. Production remains unavailable until the installed Client can read the page. */
export function OwnClassificationsWorkspace({
  state,
  page,
  frontier,
  locale,
  isCurrent,
  onRetry,
  onNext,
}: {
  state: OwnClassificationsState;
  page: OwnClassificationsPage | null;
  frontier: ClassificationFrontier;
  locale: string;
  isCurrent: () => boolean;
  onRetry: (frontier: ClassificationFrontier) => Promise<unknown>;
  onNext: (frontier: ClassificationFrontier) => void;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const [selection, select] = useState<{ generation: number; key: string } | null>(null);
  const active = isCurrent();
  const latest = useRef({ page, state, active, generation: 0 });
  if (latest.current.page !== page || latest.current.state !== state || latest.current.active !== active)
    latest.current = { page, state, active, generation: latest.current.generation + 1 };
  const generation = latest.current.generation;
  const current = () => latest.current.generation === generation && latest.current.active && isCurrent();
  let admitted: OwnClassificationsPage | null = state === 'ready' && current() ? page : null;
  let index: ReturnType<typeof indexOwnClassifications> | null = null;
  if (admitted) {
    try {
      index = indexOwnClassifications(admitted, frontier);
    } catch {
      admitted = null;
    }
  }
  const selected = admitted && selection?.generation === generation ? index?.get(selection.key) : null;
  const inspect = useRef<HTMLElement>(null);
  const feedback = () => {
    if (state === 'signed-out') return m.own_classifications_signed_out({}, options);
    if (state === 'denied') return m.own_classifications_denied({}, options);
    if (state === 'invalid-address') return m.own_classifications_invalid({}, options);
    if (state === 'stale-continuation') return m.own_classifications_stale({}, options);
    if (state === 'moved-home') return m.own_classifications_moved({}, options);
    if (state === 'preparing') return m.subject_classification_assessment_preparing({}, options);
    return m.own_classifications_unavailable({}, options);
  };
  return (
    <main className="mx-auto min-w-0 max-w-4xl space-y-6 p-4">
      <h1 className="text-2xl font-semibold">{m.own_classifications_title({}, options)}</h1>
      <p>{m.own_classifications_intro({}, options)}</p>
      {!admitted ? (
        <div role="status" className="space-y-3">
          <p>{feedback()}</p>
          {state === 'unavailable' && current() ? (
            <Button className={control} onClick={() => current() && void onRetry(frontier)}>
              {m.own_classifications_retry({}, options)}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {admitted.items.length === 0 ? (
            <p role="status">
              {admitted.next === null
                ? m.own_classifications_empty({}, options)
                : m.own_classifications_sparse({}, options)}
            </p>
          ) : null}
          <ol className="space-y-3" aria-label={m.own_classifications_title({}, options)}>
            {admitted.items.map((row) => {
              const pair = classificationPair(row);
              return (
                <li key={pair} className="min-w-0 space-y-3 rounded-xl border p-4 wrap-anywhere">
                  {row.state === 'available' ? (
                    <>
                      <p className="font-semibold">{row.subject.label ?? m.subject_value_unlabelled({}, options)}</p>
                      <p>{row.target.label ?? m.subject_value_unlabelled({}, options)}</p>
                    </>
                  ) : (
                    <p>{m.own_classifications_withheld({}, options)}</p>
                  )}
                  <OwnState row={row} locale={locale} />
                  {row.state === 'available' ? (
                    <Button
                      className={control}
                      variant="outline"
                      aria-pressed={selected === row}
                      onClick={() => {
                        if (!current()) return;
                        select({ generation, key: pair });
                        requestAnimationFrame(() => {
                          if (current()) inspect.current?.focus();
                        });
                      }}
                    >
                      {m.subject_classification_assessment_inspect({}, options)}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {selected?.state === 'available' ? (
            <section ref={inspect} tabIndex={-1} className="min-w-0 space-y-3 rounded-xl border p-4 wrap-anywhere">
              <h2 className="text-xl font-semibold">{m.subject_classification_assessment_provenance({}, options)}</h2>
              <p>
                {m.own_classifications_original({}, options)}: {selected.subjectId} · {selected.associationId}
              </p>
              <p>
                {selected.association.property} · {selected.association.release} · {selected.association.revision}
              </p>
              <dl className="space-y-2 break-all text-sm">
                {(['bindingHash', 'statementDigest', 'qualifiersDigest'] as const).map((name) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{selected.association[name]}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-3">
                {[selected.subject, selected.target].map((summary, position) => (
                  <a
                    key={position}
                    className={`${control} inline-flex items-center underline`}
                    href={subjectHref({ id: summary.id, label: '' }, locale).href}
                    onClick={(event) => {
                      if (!current()) event.preventDefault();
                    }}
                  >
                    {summary.label ?? m.subject_value_unlabelled({}, options)}
                  </a>
                ))}
              </div>
              <Aggregate row={selected} locale={locale} />
              <p role="status">
                {selected.actions.state === 'read-only' || selected.actions.state === 'withheld'
                  ? m.own_classifications_read_only({}, options)
                  : m.own_classifications_commands_unavailable({}, options)}
              </p>
            </section>
          ) : null}
          {admitted.next !== null ? (
            <Button
              className={control}
              onClick={() => {
                if (current()) onNext({ cursor: admitted.next, selected: frontier.selected });
              }}
            >
              {m.own_classifications_next({}, options)}
            </Button>
          ) : null}
        </>
      )}
    </main>
  );
}

function OwnState({ row, locale }: { row: OwnClassification; locale: string }) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <div className="space-y-1 text-sm">
      <p>
        {row.own.assessment === 'support'
          ? m.subject_classification_assessment_own_support({}, options)
          : m.subject_classification_assessment_own_oppose({}, options)}
      </p>
      {row.own.falsePositive ? <p>{m.subject_classification_assessment_own_lie({}, options)}</p> : null}
      <p>
        {row.own.pending === 'current'
          ? m.own_classifications_current({}, options)
          : row.own.pending === 'pending'
            ? m.subject_classification_assessment_pending({}, options)
            : m.own_classifications_unknown({}, options)}
      </p>
      <p>
        {m.own_classifications_revision({}, options)}: {row.own.revision}
      </p>
    </div>
  );
}

function Aggregate({ row, locale }: { row: OwnClassification; locale: string }) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  if (!row.aggregate) return null;
  if (row.aggregate.state === 'suppressed') return <p>{m.subject_classification_assessment_suppressed({}, options)}</p>;
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="space-y-1">
      <h3>{m.subject_classification_assessment_published({}, options)}</h3>
      <p>
        {m.subject_classification_assessment_support_count(
          { count: number.format(row.aggregate.supportCount) },
          options,
        )}
      </p>
      <p>
        {m.subject_classification_assessment_oppose_count({ count: number.format(row.aggregate.opposeCount) }, options)}
      </p>
      <p>
        {m.subject_classification_assessment_lie_count(
          { count: number.format(row.aggregate.falsePositiveCount) },
          options,
        )}
      </p>
    </div>
  );
}
