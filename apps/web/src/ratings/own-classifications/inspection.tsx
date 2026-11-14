import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import { ClassificationEditor, type ClassificationCommands } from './editor';
import type { OwnClassification } from './types';

export const classificationControl = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2';

/** Supplied detail belongs to exactly one original inventory occurrence. */
export function ClassificationInspection({
  id,
  row,
  commands,
  locale,
  isCurrent,
  refresh,
  onProtection,
  onClose,
}: {
  id: string;
  row: OwnClassification;
  commands?: ClassificationCommands | undefined;
  locale: string;
  isCurrent: () => boolean;
  refresh: () => Promise<unknown>;
  onProtection: (value: boolean) => void;
  onClose: () => void;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      className="min-w-0 space-y-3 border-t pt-3 wrap-anywhere"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          if (isCurrent()) onClose();
        }
      }}
    >
      <Button className={classificationControl} variant="outline" onClick={() => isCurrent() && onClose()}>
        {m.own_classifications_close({}, options)}
      </Button>
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {row.state === 'available'
          ? `${row.subject.label ?? m.subject_value_unlabelled({}, options)} · ${row.target.label ?? m.subject_value_unlabelled({}, options)}`
          : m.own_classifications_withheld({}, options)}
      </h2>
      <OwnState row={row} locale={locale} />
      <ClassificationAvailability row={row} locale={locale} />
      {commands ? (
        <ClassificationEditor
          row={row}
          commands={commands}
          locale={locale}
          isCurrent={isCurrent}
          refresh={refresh}
          onProtection={onProtection}
        />
      ) : (
        <p role="status">{m.own_classifications_commands_unavailable({}, options)}</p>
      )}
      {row.state === 'available' ? (
        <>
          <details>
            <summary className={`${classificationControl} cursor-pointer rounded py-3 underline`}>
              {m.own_classifications_technical({}, options)}
            </summary>
            <div className="min-w-0 space-y-3 pt-3">
              <h3>{m.subject_classification_assessment_provenance({}, options)}</h3>
              <dl className="space-y-2 break-all text-sm">
                <div>
                  <dt>{m.own_classifications_original({}, options)}</dt>
                  <dd>
                    {row.subjectId} · {row.associationId}
                  </dd>
                </div>
                <div>
                  <dt>{m.own_classifications_revision({}, options)}</dt>
                  <dd>{row.own.revision}</dd>
                </div>
                {Object.entries(row.association).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-3">
                {[row.subject, row.target].map((summary, position) => (
                  <a
                    key={position}
                    className={`${classificationControl} inline-flex items-center underline`}
                    href={subjectHref({ id: summary.id, label: '' }, locale).href}
                    onClick={(event) => {
                      if (!isCurrent()) event.preventDefault();
                    }}
                  >
                    {summary.label ?? m.subject_value_unlabelled({}, options)}
                  </a>
                ))}
              </div>
            </div>
          </details>
          <Aggregate row={row} locale={locale} />
        </>
      ) : null}
    </section>
  );
}

export function ClassificationAvailability({ row, locale }: { row: OwnClassification; locale: string }) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  if (row.actions.state === 'withheld')
    return <p role="status">{m.own_classifications_actions_withheld({}, options)}</p>;
  if (row.actions.state === 'withdraw-only') return <p>{m.own_classifications_withdraw_only({}, options)}</p>;
  if (row.actions.state === 'read-only') return <p>{m.own_classifications_read_only({}, options)}</p>;
  return null;
}

export function OwnState({ row, locale }: { row: OwnClassification; locale: string }) {
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
      {row.aggregate.supportFraction !== null ? (
        <p>
          {m.subject_classification_assessment_support_fraction(
            { fraction: number.format(row.aggregate.supportFraction * 100) },
            options,
          )}
        </p>
      ) : null}
      <p>{m.subject_classification_assessment_as_of({ date: row.aggregate.asOf }, options)}</p>
      <p>{m.library_publication_published_generation({ generation: row.aggregate.generation }, options)}</p>
    </div>
  );
}
