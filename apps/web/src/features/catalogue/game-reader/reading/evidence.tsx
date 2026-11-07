import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { m } from '../../../../paraglide/messages.js';
import { historicalStatement } from '../../release-fidelity/model';
import { useWorkReading, type WorkReadingLink } from '../../work-reading-port';
import { gameDatePresentation } from '../date';
import type { GameReaderReady, GameStatement } from '../model';
import { action } from './controls';

type FactProps = {
  statement: GameStatement;
  page: GameReaderReady;
  related: SubjectRead['related'];
  locale: string;
  link: WorkReadingLink;
};

export function GameFact(props: FactProps & { date: boolean }) {
  const { statement, page, related, locale, link: Link } = props;
  const reading = useWorkReading();
  const o = { locale: locale as never };
  const date = props.date ? gameDatePresentation(statement, page.digest, locale) : undefined;
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const value = () => reading.renderValue({ snak: statement, related, locale, link: Link });
  return (
    <div className="space-y-2">
      {date ? (
        <p data-date-kind={date.kind}>
          {date.structuredDate ? <time dateTime={date.structuredDate}>{date.text}</time> : date.text}
        </p>
      ) : statement.property.data_type === 'wikibase-item' &&
        typeof content === 'string' &&
        !pickText(related[content]?.labels ?? {}, locale).text ? (
        <p>{m.work_parts_unresolved({}, o)}</p>
      ) : (
        value()
      )}
      <GameEvidence {...props} />
    </div>
  );
}

export function GameEvidence({ statement, page, related, locale, link: Link }: FactProps) {
  const reading = useWorkReading();
  const o = { locale: locale as never };
  const value = (snak: GameStatement | GameStatement['qualifiers'][number]) =>
    reading.renderValue({ snak, related, locale, link: Link });
  return (
    <div className="space-y-2">
      {statement.qualifiers.length ? (
        <dl className="space-y-1 text-sm">
          {statement.qualifiers.map((part, index) => (
            <div key={index}>
              <dt className="font-medium" lang={page.labels[part.property.id]?.lang ?? undefined}>
                {page.labels[part.property.id]?.text || part.property.id}
              </dt>
              <dd>{value(part)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {historicalStatement(statement, page.digest) ? (
        <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
      ) : null}
      <details className="rounded-lg border border-border p-3">
        <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
        {statement.references.map((reference, index) => (
          <dl key={index} data-reference={reference.hash} className="space-y-1">
            {reference.parts.map((part, n) => (
              <div key={n}>
                <dt className="font-medium">{page.labels[part.property.id]?.text || part.property.id}</dt>
                <dd>{value(part)}</dd>
              </div>
            ))}
          </dl>
        ))}
        <p className="text-sm">
          {statement.id} · {statement.rank} · {statement.rezics.release}
        </p>
      </details>
    </div>
  );
}
