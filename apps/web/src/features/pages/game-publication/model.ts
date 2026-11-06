import { pickText } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import { gameGroups, gameType, type GameGroup } from '../../catalogue/game-profile';
import { composedSubjectRead } from '../../catalogue/music-reader';
import { isA } from '../../catalogue/release-fidelity/model';
import type { GameReaderRead, GameStatement } from '../../catalogue/game-reader/model';
import { gameReaderEntry } from '../../catalogue/game-reader/model';
import type { Related, Subject, Summary } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import {
  GAME_PUBLICATION_PROPERTIES,
  publicationOverlayKind,
  publicationOverlayReading,
  publicPublicationStatements,
  subjectPublicationFields,
  type PublicationDefinitions,
  type PublicationField,
} from '../subject-metadata';
import { pageText } from '../shared';

export type GamePublicationField = PublicationField & {
  label: ReturnType<typeof pageText>;
};

export type GamePublicationReading = {
  type: 'schema:VideoGame';
  fields: GamePublicationField[];
};

const GAME_PROPERTY_SET = new Set<string>(GAME_PUBLICATION_PROPERTIES);

/** Project platform from the current anonymous game page so served HTML matches JSON-LD. */
export function gamePublicationReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
): GamePublicationReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== 'game') return;
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!GAME_PROPERTY_SET.has(field.property)) return [];
    return [{ ...field, label: pageText(definitions?.properties[field.property]?.labels, locale) }];
  });
  return fields.length ? { type: 'schema:VideoGame', fields } : undefined;
}

const expected = {
  platform: ['schema:gamePlatform'],
  engine: ['wdt:P408'],
  language: ['schema:inLanguage'],
  status: ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'],
} as const;

/** Feed GameReader from the current anonymous page; editions stay a later continuation. */
export function gamePageInitial(
  subject: Subject,
  related: Related,
  summary: Summary | null | undefined,
  definitions: PublicationDefinitions,
  digest: string,
  locale: string,
  reader: Reader = defaultReader,
): GameReaderRead | undefined {
  if (!gameReaderEntry(subject.type, summary?.types) && publicationOverlayKind(subject.type, definitions) !== 'game')
    return;
  const admitted =
    gameType(definitions, subject.type) &&
    !isA(definitions, subject.type, 'wd:Q20631656') &&
    !isA(definitions, subject.type, 'wd:Q209163');
  const groups = admitted
    ? (Object.entries(gameGroups(definitions, subject.type)) as [GameGroup, string[]][]).map(([id, properties]) => ({
        id,
        fields: properties.flatMap((property) => {
          const statements = publicPublicationStatements(subject, property, reader, locale);
          if (!statements.length && definitions.properties[property]?.datatype !== 'time') return [];
          return [
            {
              property,
              label: pickText(definitions.properties[property]?.labels ?? {}, locale),
              date: definitions.properties[property]?.datatype === 'time',
              statements: statements as GameStatement[],
            },
          ];
        }),
      }))
    : [];
  const grouped: Extract<GameReaderRead, { ok: true }>['groups'] = [];
  for (const id of ['facts', 'classification', 'credits', 'relations'] as const) {
    const group = groups.find((entry) => entry.id === id);
    if (group?.fields.length) grouped.push({ id, fields: group.fields });
  }
  const unsupported: Extract<GameReaderRead, { ok: true }>['unsupported'] = [];
  for (const kind of ['platform', 'engine', 'language', 'status'] as const)
    if (
      admitted &&
      !expected[kind].some(
        (property) =>
          definitions.types[subject.type]?.properties.includes(property) && definitions.properties[property],
      )
    )
      unsupported.push(kind);
  const publicRead: SubjectRead = composedSubjectRead({
    subject,
    related,
    summary: summary ?? null,
  });
  return {
    ok: true,
    public: publicRead,
    digest,
    admitted,
    grain: pickText(definitions.types[subject.type]?.labels ?? {}, locale),
    groups: grouped,
    unsupported,
    editions: [],
    editionTypes: Object.keys(definitions.types).filter(
      (type) => type === 'wd:Q20631656' || (definitions.types[type]?.bases ?? []).includes('wd:Q20631656'),
    ),
    editionsAdmitted: false,
    next: null,
    caughtUp: true,
    labels: Object.fromEntries(
      Object.entries(definitions.properties).map(([id, property]) => [id, pickText(property.labels, locale)]),
    ),
  };
}

export function gameOverlayReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
) {
  return publicationOverlayReading(subject, definitions, locale, 'game', reader);
}
