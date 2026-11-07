import type { SubjectRead } from '@rezics/client';
import { m } from '../../../../paraglide/messages.js';
import type { WorkReadingLink } from '../../work-reading-port';
import type { GameReaderReady } from '../model';
import { GameFact } from './evidence';

type WorkReleaseCardView = Extract<
  NonNullable<GameReaderReady['workReleaseCards']>,
  { state: 'available' }
>['cards'][number];
type WorkReleaseCardProperty = keyof WorkReleaseCardView['fields'];

/** Comparison cards keep the native inverse-link order of the current bounded release page. */
export function WorkReleaseComparison({
  card,
  page,
  locale,
  link,
}: {
  card: WorkReleaseCardView;
  page: GameReaderReady;
  locale: string;
  link: WorkReadingLink;
}) {
  const o = { locale: locale as never };
  const related: SubjectRead['related'] = Object.fromEntries(
    Object.entries(card.related).map(([id, item]) => [
      id,
      { type: item.type, labels: item.label ? { [item.label.language]: item.label.value } : {} },
    ]),
  );
  const groups: { id: string; label: string; properties: WorkReleaseCardProperty[] }[] = [
    { id: 'platform', label: m.game_reader_compare_platform_label({}, o), properties: ['schema:gamePlatform'] },
    { id: 'language', label: m.game_reader_compare_language_label({}, o), properties: ['schema:inLanguage'] },
    { id: 'date', label: m.game_reader_compare_date_label({}, o), properties: ['schema:datePublished'] },
    {
      id: 'status',
      label: m.game_reader_compare_status_label({}, o),
      properties: ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'],
    },
    { id: 'age', label: m.game_reader_compare_age_label({}, o), properties: ['wdt:P2899', 'schema:contentRating'] },
    { id: 'publisher', label: m.game_reader_compare_publisher_label({}, o), properties: ['schema:publisher'] },
    { id: 'producer', label: m.game_reader_compare_producer_label({}, o), properties: ['schema:producer', 'wdt:P162'] },
    { id: 'developer', label: m.game_reader_compare_developer_label({}, o), properties: ['wdt:P178'] },
  ];
  return (
    <section className="mt-3 space-y-2" data-slot="work-release-comparison">
      <h4 className="font-semibold">{m.game_reader_compare_title({}, o)}</h4>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
        {groups.map((group) => {
          const fields = group.properties.map((property) => card.fields[property]);
          const available = fields.filter((field) => field.state === 'available');
          const states = [
            ...new Set(fields.filter((field) => field.state !== 'available').map((field) => field.state)),
          ];
          return (
            <div key={group.id} className="min-w-0 rounded-md bg-muted/40 p-2">
              <dt className="font-medium">{group.label}</dt>
              <dd className="mt-1 space-y-2">
                {available.flatMap((field) =>
                  field.statements.map((statement) => (
                    <GameFact
                      key={statement.id}
                      statement={statement}
                      page={page}
                      related={related}
                      locale={locale}
                      date={statement.property.id === 'schema:datePublished'}
                      link={link}
                    />
                  )),
                )}
                {states.map((state) => (
                  <p key={state} className={available.length ? 'text-sm text-muted-foreground' : undefined}>
                    {state === 'unavailable'
                      ? m.game_reader_compare_field_unavailable({}, o)
                      : state === 'withheld'
                        ? m.game_reader_compare_withheld({}, o)
                        : state === 'missing'
                          ? m.game_reader_compare_missing({}, o)
                          : m.game_reader_compare_unsupported({}, o)}
                  </p>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
