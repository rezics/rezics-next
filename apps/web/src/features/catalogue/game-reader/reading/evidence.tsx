import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { m } from '../../../../paraglide/messages.js';
import { historicalStatement } from '../../release-fidelity/model';
import { useWorkReading, type WorkReadingLink } from '../../work-reading-port';
import { gameDateLabel, gameDatePresentation } from '../date';
import type { GameReaderReady, GameStatement } from '../model';
import { action } from './controls';

type FactProps = {
  statement: GameStatement;
  page: GameReaderReady;
  related: SubjectRead['related'];
  locale: string;
  link: WorkReadingLink;
};

export function GameFact(props: FactProps & { date: boolean; compact?: boolean }) {
  const { statement, page, related, locale, link: Link } = props;
  const reading = useWorkReading();
  const o = { locale: locale as never };
  const date = props.date ? gameDatePresentation(statement, page.digest, locale) : undefined;
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const value = () => reading.renderValue({ snak: statement, related, locale, link: Link });
  return (
    <div className="space-y-2">
      {date ? (
        <p data-date-kind={date.kind} className="min-w-0 break-words">
          {date.structuredDate ? (
            <time dateTime={date.structuredDate} title={date.text}>
              {gameDateLabel(date, locale)}
            </time>
          ) : (
            date.text
          )}
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

export function GameEvidence({
  statement,
  page,
  related,
  locale,
  link: Link,
}: FactProps & { compact?: boolean | undefined }) {
  const reading = useWorkReading();
  const o = { locale: locale as never };
  const value = (snak: GameStatement | GameStatement['qualifiers'][number]) =>
    reading.renderValue({ snak, related, locale, link: Link });
  const qualifiers = statement.qualifiers.length ? (
    <dl className="min-w-0 space-y-2 text-sm">
      {statement.qualifiers.map((part, index) => (
        <div key={index} className="min-w-0">
          <dt className="break-words font-medium" lang={page.labels[part.property.id]?.lang ?? undefined}>
            {page.labels[part.property.id]?.text || (
              <code className="break-all font-mono text-xs">{part.property.id}</code>
            )}
          </dt>
          <dd className="min-w-0 break-words">{value(part)}</dd>
        </div>
      ))}
    </dl>
  ) : null;
  return (
    <div className="space-y-2">
      {historicalStatement(statement, page.digest) ? (
        <p className="border-l-2 border-muted-foreground/50 pl-2 text-sm text-muted-foreground">
          {m.release_fidelity_historical({}, o)}
        </p>
      ) : null}
      <details
        data-slot="game-fact-evidence"
        className="min-w-0 overflow-hidden rounded-md border border-border text-sm"
      >
        <summary className={`${action} cursor-pointer px-2 py-1 text-primary`}>
          {m.game_reader_evidence({}, o)}
        </summary>
        <div className="min-w-0 space-y-3 border-t border-border bg-muted/20 p-3">
          {qualifiers}
          {statement.property.data_type === 'time' ? (
            <dl className="min-w-0 rounded-md bg-muted/30 p-3">
              <dt className="font-medium">{m.game_reader_native_value({}, o)}</dt>
              <dd className="break-all font-mono text-xs">{JSON.stringify(statement.value)}</dd>
            </dl>
          ) : null}
          {statement.references.map((reference, index) => (
            <dl
              key={index}
              data-reference={reference.hash}
              className="min-w-0 space-y-2 rounded-md border border-border bg-muted/30 p-3"
            >
              {reference.parts.map((part, n) => (
                <div key={n} className="min-w-0">
                  <dt className="break-words font-medium" lang={page.labels[part.property.id]?.lang ?? undefined}>
                    {page.labels[part.property.id]?.text || (
                      <code className="break-all font-mono text-xs">{part.property.id}</code>
                    )}
                  </dt>
                  <dd className="min-w-0 break-words">{value(part)}</dd>
                </div>
              ))}
            </dl>
          ))}
          <p className="break-all rounded-md bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
            {statement.id} · {statement.rank} · {statement.rezics.release}
          </p>
        </div>
      </details>
    </div>
  );
}
