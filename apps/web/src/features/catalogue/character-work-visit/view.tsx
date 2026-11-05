import { m } from '../../../paraglide/messages.js';
import { CoverList } from '../../pages/cover-list';
import { CandidateValue } from '../../pages/data';
import { SpoilerGate } from '../../pages/values';
import type { OverviewValue } from '../../pages/overview';
import type { ConnectionSection } from '../../pages/subject-connections';
import type { ConnectionReturnWindow } from '../../pages/subject-visit-navigation';
import { connectionReturnHref, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { valueExplanationHref } from '../value-explanation';
import { isRecord, type Snak } from '../../pages/shared';
import { relationTargetHref } from '../../pages/edition-work';
import { characterWorkRows, type CharacterWorkKind, type CharacterWorkRow } from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Adapter over the selected section owned by SubjectConnections, including its existing More/Retry controls. */
export function CharacterWorkRows({
  current,
  value,
  kind,
  returnWindow,
}: {
  current: ConnectionSection;
  value: OverviewValue;
  kind: CharacterWorkKind;
  returnWindow?: ConnectionReturnWindow | undefined;
}) {
  const rows = characterWorkRows(current, value.subject!, value.locale, value.reader.spoilerLevel);
  const o = { locale: value.locale as never };
  const raw = current.section.ok ? current.section.body.links : undefined;
  const freshness = current.section.ok && isRecord(current.section.body) ? current.section.body.freshness : undefined;
  const partial =
    (current.section.ok && isRecord(current.section.body) && current.section.body.partial === true) ||
    (isRecord(freshness) && freshness.caught_up === false);
  return (
    <div className="min-w-0 space-y-6" data-slot="character-work-visit">
      {rows.map((row, index) => (
        <CharacterWorkAppearance
          key={JSON.stringify([row, value.context, value.reader, index])}
          row={row}
          current={current}
          value={value}
          kind={kind}
          returnWindow={returnWindow}
        />
      ))}
      {Array.isArray(raw) && raw.length > rows.length && <p role="status">{m.character_work_unavailable({}, o)}</p>}
      {partial && <p role="status">{m.character_work_unavailable({}, o)}</p>}
    </div>
  );
}

function CharacterWorkAppearance({
  row,
  current,
  value,
  kind,
  returnWindow,
}: {
  row: CharacterWorkRow;
  current: ConnectionSection;
  value: OverviewValue;
  kind: CharacterWorkKind;
  returnWindow?: ConnectionReturnWindow | undefined;
}) {
  const o = { locale: value.locale as never };
  const returnHref = connectionReturnHref(
    value.subject!,
    value.subjectLabel ?? value.unlabelled,
    value.locale,
    value.realm,
    current.reading
      ? {
          ...(returnWindow ?? {
            stream: current.stream.key,
            reading: current.reading,
            ...(current.section.ok && 'cursor' in current.section.read && current.section.read.cursor
              ? { cursor: current.section.read.cursor }
              : {}),
          }),
          ...(row.statement ? { focus: row.statement, holder: row.holder } : {}),
        }
      : undefined,
  );
  const Link = value.link;
  const WorkLink: typeof Link = (props) => (
    <Link {...props} href={withSubjectVisitReturn(props.href, returnHref, value.locale)} />
  );
  const title = row.item.label.text || value.unlabelled;
  const sources = new URL(
    relationTargetHref({ id: row.holder, label: title }, value.locale, value.context),
    'https://rezics.invalid',
  );
  sources.pathname += '/sources';
  const notes = row.item.qualified ?? [];
  const role = notes.some((note) => note.property === 'wdt:P3831');
  const performer = row.performer;
  const content = (
    <article
      className="min-w-0 space-y-3 rounded-lg border border-border p-3 [overflow-wrap:anywhere]"
      data-work-statement={row.statement}
      data-work-holder={row.statement ? row.holder : undefined}
    >
      <p className="text-sm text-muted-foreground">
        {current.stream.forwardLabel} · {current.stream.label}
      </p>
      <CoverList
        items={[
          {
            ...row.item,
            gated: false,
            qualified: [
              ...notes,
              ...(performer
                ? [{ text: `${m.character_work_performer({}, o)}: ${performer.label}`, subject: performer }]
                : []),
            ],
          },
        ]}
        value={{ ...value, link: WorkLink }}
        label={kind === 'appearance' ? m.character_work_appearances({}, o) : m.character_work_performances({}, o)}
      />
      {(!role || (kind === 'performance' && !performer)) && (
        <p className="text-sm text-muted-foreground">{m.character_work_qualification_unavailable({}, o)}</p>
      )}
      <nav className="flex min-w-0 flex-wrap gap-3" aria-label={m.character_work_original({}, o)}>
        {row.statement ? (
          <a
            className={action}
            target="_blank"
            rel="noopener noreferrer"
            href={valueExplanationHref(
              {
                id: row.holder,
                title,
                property: current.stream.property,
                statement: row.statement,
                ...(value.context ? { context: value.context.id } : {}),
              },
              value.locale,
            )}
          >
            {m.character_work_original({}, o)} <span className="ms-1">{m.character_work_new_tab({}, o)}</span>
          </a>
        ) : (
          <p role="status">{m.character_work_unavailable({}, o)}</p>
        )}
        <WorkLink className={action} href={`${sources.pathname}${sources.search}`}>
          {m.subject_sources({}, o)}
        </WorkLink>
      </nav>
      {row.original && (
        <details className="min-w-0 space-y-2">
          <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
          {row.original.references.length ? (
            <ul className="space-y-3">
              {row.original.references.map((reference, index) => (
                <li key={index} className="space-y-2">
                  {reference.parts
                    .filter((snak) => disclosedPart(snak, row))
                    .map((snak, index) => (
                      <div key={index}>
                        <CandidateValue snak={snak} related={row.related} locale={value.locale} link={WorkLink} />
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          ) : (
            <p>{m.work_relation_citations_undisclosed({}, o)}</p>
          )}
        </details>
      )}
    </article>
  );
  return row.item.gated ? (
    <SpoilerGate label={value.spoilerShow} hideLabel={value.labels.spoilerHide}>
      {content}
    </SpoilerGate>
  ) : (
    content
  );
}

/** Missing item summaries never become raw identifier captions in citation values. */
function disclosedPart(snak: Snak, row: CharacterWorkRow) {
  return (
    snak.property.data_type !== 'wikibase-item' ||
    snak.value.type !== 'value' ||
    (typeof snak.value.content === 'string' &&
      Object.values(row.related[snak.value.content]?.labels ?? {}).some(Boolean))
  );
}
