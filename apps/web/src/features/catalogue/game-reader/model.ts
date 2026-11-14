import type {
  KernelClient,
  SubjectLinksResponse,
  SubjectRead,
  SubjectReadQuery,
  WorkReleaseCard,
  WorkReleaseCardField,
  WorkReleaseCards,
} from '@rezics/client';
import { pickText } from '@rezics/composition';
import { gameGroups, gameType, gameUuid, type GameGroup } from '../game-profile';
import type { GuideRelease } from '../definition-guide';
import { isA, selectedStatements } from '../release-fidelity/model';
import { encodedBytes } from '../release-fidelity/encoding';

export const editionProperty = 'schema:exampleOfWork';
export const gameReaderLimit = 20;
type Endpoint = ReturnType<KernelClient['subjects']>;
type Links = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
export type GameStatement = SubjectRead['subject']['statements'][string][number];
export type GameReaderAddress = { id: string; context: string; type: string; cursor?: string };
export type GameReaderRead =
  | { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' | 'restart' }
  | {
      ok: true;
      public: SubjectRead;
      digest: string;
      admitted: boolean;
      grain: ReturnType<typeof pickText>;
      groups: { id: GameGroup; fields: GameReaderField[] }[];
      unsupported: ('platform' | 'engine' | 'language' | 'status')[];
      editions: Links['links'];
      workReleaseCards?: WorkReleaseCards;
      editionTypes: string[];
      editionsAdmitted: boolean;
      editionFailure?: { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' | 'restart' };
      next: string | null;
      caughtUp: boolean;
      labels: Record<string, ReturnType<typeof pickText>>;
    };
export type GameReaderField = {
  property: string;
  label: ReturnType<typeof pickText>;
  date: boolean;
  statements: GameStatement[];
};
export type GameReaderTransport = (address: GameReaderAddress) => Promise<GameReaderRead>;
export type GameReaderReady = Extract<GameReaderRead, { ok: true }>;

/** The ordinary reader owns works. Add-ons and actual software releases retain their separate readers. */
export function gameWork(release: GuideRelease, type: string): boolean {
  return gameType(release, type) && !isA(release, type, 'wd:Q20631656') && !isA(release, type, 'wd:Q209163');
}
export function gameReaderEntry(type: string, bases?: readonly string[]): boolean {
  return (
    type !== 'wd:Q20631656' &&
    type !== 'wd:Q209163' &&
    (type === 'schema:VideoGame' || type === 'wd:Q689445' || !!bases?.includes('schema:VideoGame'))
  );
}
export function validGameReaderAddress(address: GameReaderAddress): boolean {
  return (
    !!address &&
    gameUuid.test(address.id) &&
    gameUuid.test(address.context) &&
    typeof address.type === 'string' &&
    address.type.length > 0 &&
    address.type.length <= 256 &&
    (address.cursor === undefined ||
      (typeof address.cursor === 'string' && address.cursor.length > 0 && address.cursor.length <= 4096))
  );
}
const expected = {
  platform: ['schema:gamePlatform'],
  engine: ['wdt:P408'],
  language: ['schema:inLanguage'],
  status: ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'],
};
const failure = (status: number): GameReaderRead => ({
  ok: false,
  reason: [403, 404, 308].includes(status) ? 'withheld' : 'unavailable',
});

/** Four bounded reads: Subject, active pointer, immutable release and one inverse edition page. No target hydration. */
export async function readGameReader(
  client: KernelClient,
  definitions: GuideRelease | Promise<GuideRelease>,
  address: GameReaderAddress,
  locale: string,
): Promise<GameReaderRead> {
  if (!validGameReaderAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({
        query: { context: address.context, language: locale, includeViewerActions: true } as SubjectReadQuery,
      }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    const read = current.data as SubjectRead;
    if (
      read.subject.id !== address.id ||
      read.subject.context !== address.context ||
      read.subject.type !== address.type
    )
      return { ok: false, reason: 'withheld' };
    if (encodedBytes(read) > 2 * 1024 * 1024) return { ok: false, reason: 'unavailable' };
    const admitted = gameWork(release, address.type);
    const groups = admitted
      ? Object.entries(gameGroups(release, address.type)).map(([id, properties]) => ({
          id,
          fields: properties.flatMap((property) => {
            const statements = selectedStatements(read.subject.statements[property]);
            if (!statements.length && release.properties[property]!.datatype !== 'time') return [];
            return [
              {
                property,
                label: pickText(release.properties[property]!.labels, locale),
                date: release.properties[property]!.datatype === 'time',
                statements,
              },
            ];
          }),
        }))
      : [];
    // Keep grouping typed without converting source values or inventing fields.
    const grouped: GameReaderReady['groups'] = [];
    for (const id of ['facts', 'classification', 'credits', 'relations'] as const) {
      const group = groups.find((group) => group.id === id);
      if (group?.fields.length) grouped.push({ id, fields: group.fields });
    }
    const unsupported: GameReaderReady['unsupported'] = [];
    for (const kind of ['platform', 'engine', 'language', 'status'] as const)
      if (
        admitted &&
        !expected[kind].some(
          (property) => release.types[address.type]?.properties.includes(property) && release.properties[property],
        )
      )
        unsupported.push(kind);
    const editionTypes = Object.keys(release.types).filter((type) => isA(release, type, 'wd:Q20631656'));
    const relation = release.properties[editionProperty];
    const editionsAdmitted =
      admitted &&
      !!relation?.relation?.inverse &&
      relation.relation.inverse !== 'none' &&
      !!relation.targets?.some((target) => isA(release, address.type, target)) &&
      editionTypes.some((type) => release.types[type]?.properties.includes(editionProperty));
    if (address.cursor && !editionsAdmitted) return { ok: false, reason: 'invalid' };
    const common: GameReaderReady = {
      ok: true,
      public: read,
      digest: release.digest,
      admitted,
      grain: pickText(release.types[address.type]?.labels ?? {}, locale),
      groups: grouped,
      unsupported,
      editions: [],
      editionTypes,
      editionsAdmitted,
      next: null,
      caughtUp: true,
      labels: Object.fromEntries(
        Object.entries(release.properties).map(([id, property]) => [id, pickText(property.labels, locale)]),
      ),
    };
    if (!editionsAdmitted) return common;
    const response = await client.subjects({ id: address.id }).links.get({
      query: {
        property: editionProperty,
        context: address.context,
        language: locale,
        limit: gameReaderLimit,
        ...(address.cursor ? { cursor: address.cursor } : {}),
      },
    });
    return gameReaderEditionPage(common, address, response.status, response.data);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function responseObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Admit the same native inverse page whether it arrived in composition or through explicit continuation. */
export function gameReaderEditionPage(
  common: GameReaderReady,
  address: GameReaderAddress,
  status: number,
  body: unknown,
): GameReaderRead {
  // The links owner currently reports both stale and invalid cursors as invalid_request.
  // Neither means that the native stream is exhausted or that retrying the token will help.
  if (status === 400 && address.cursor) return { ok: false, reason: 'restart' };
  if (status !== 200 || !responseObject(body)) return failure(status);
  const page = body as SubjectLinksResponse;
  if (!Array.isArray(page.links) || !responseObject(page.freshness) || typeof page.freshness.caught_up !== 'boolean')
    return { ok: false, reason: 'unavailable' };
  const { workReleaseCards, ...membershipPage } = page;
  if (
    page.links.length > gameReaderLimit ||
    encodedBytes(membershipPage) > gameReaderLimit * 128 * 1024 + 64 * 1024 ||
    (page.next !== null &&
      (typeof page.next !== 'string' || !page.next.length || page.next.length > 4096 || page.next === address.cursor))
  )
    return { ok: false, reason: 'unavailable' };
  const seen = new Set<string>();
  for (const row of page.links) {
    if (!responseObject(row) || typeof row.subject !== 'string' || typeof row.statement !== 'string')
      return { ok: false, reason: 'unavailable' };
    const key = `${row.subject}:${row.statement}`;
    if (
      encodedBytes(row) > 128 * 1024 ||
      seen.has(key) ||
      !gameUuid.test(row.subject) ||
      !gameUuid.test(row.statement) ||
      row.property !== editionProperty ||
      (row.summary != null && (!responseObject(row.summary) || row.summary.id !== row.subject)) ||
      (row.assertion !== undefined &&
        (!responseObject(row.assertion) ||
          row.assertion.id !== row.statement ||
          !responseObject(row.assertion.property) ||
          !responseObject(row.assertion.value) ||
          row.assertion.property.id !== editionProperty ||
          row.assertion.value.type !== 'value' ||
          row.assertion.value.content !== address.id))
    )
      return { ok: false, reason: 'unavailable' };
    seen.add(key);
  }
  return {
    ...common,
    editions: page.links,
    workReleaseCards: admitComparison(workReleaseCards, page.links, address.id),
    next: page.next,
    caughtUp: page.freshness.caught_up,
  };
}

// Bind the installed HTTP union here, rather than making the renderer repair external facts.
// These are the native copy-work-reader-port limits; the client exports their types, not runtime constants.
const comparisonProperties = {
  'schema:gamePlatform': true,
  'schema:inLanguage': true,
  'schema:datePublished': true,
  'schema:creativeWorkStatus': true,
  'wdt:P5804': true,
  'rezics:releaseStatus': true,
  'schema:contentRating': true,
  'schema:publisher': true,
  'schema:producer': true,
  'wdt:P178': true,
  'wdt:P162': true,
  'wdt:P2899': true,
} satisfies Record<keyof WorkReleaseCard['fields'], true>;
const comparisonDataTypes = {
  document: true,
  'external-id': true,
  media: true,
  monolingualtext: true,
  quantity: true,
  string: true,
  time: true,
  url: true,
  'wikibase-item': true,
} satisfies Record<GameStatement['property']['data_type'], true>;
const comparisonEmptyStates = {
  unsupported: true,
  withheld: true,
  missing: true,
  unavailable: true,
} satisfies Record<Exclude<WorkReleaseCardField['state'], 'available'>, true>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function comparisonSummary(value: unknown, id: string): value is WorkReleaseCard['summary'] {
  if (
    !record(value) ||
    value.id !== id ||
    typeof value.type !== 'string' ||
    !stringArray(value.types) ||
    typeof value.creativeWork !== 'boolean' ||
    (value.label !== null &&
      (!record(value.label) || typeof value.label.language !== 'string' || typeof value.label.value !== 'string'))
  )
    return false;
  const cover = value.cover;
  if (cover === null) return true;
  return (
    record(cover) &&
    typeof cover.media === 'string' &&
    Number.isInteger(cover.width) &&
    Number.isInteger(cover.height) &&
    record(cover.placeholder) &&
    typeof cover.placeholder.thumbhash === 'string' &&
    typeof cover.placeholder.color === 'string' &&
    Array.isArray(cover.variants) &&
    cover.variants.every(
      (variant) =>
        record(variant) &&
        (variant.format === 'avif' || variant.format === 'webp') &&
        Number.isInteger(variant.width),
    ) &&
    (cover.focalPoint === null ||
      (record(cover.focalPoint) && Number.isFinite(cover.focalPoint.x) && Number.isFinite(cover.focalPoint.y))) &&
    record(cover.credit) &&
    typeof cover.credit.rightsHolder === 'string' &&
    record(cover.credit.via) &&
    typeof cover.credit.via.name === 'string' &&
    typeof cover.credit.via.url === 'string' &&
    typeof cover.credit.license === 'string' &&
    stringArray(cover.credit.obligations)
  );
}

function comparisonRelated(value: unknown): value is WorkReleaseCard['related'] {
  return record(value) && Object.entries(value).every(([id, summary]) => comparisonSummary(summary, id));
}

function comparisonSnak(value: unknown): value is GameStatement['qualifiers'][number] {
  if (
    !record(value) ||
    !record(value.property) ||
    typeof value.property.id !== 'string' ||
    typeof value.property.data_type !== 'string' ||
    !Object.hasOwn(comparisonDataTypes, value.property.data_type) ||
    !record(value.value)
  )
    return false;
  // Native content is unknown. Keep dates, quantities, documents and source text as supplied.
  return (
    (value.value.type === 'value' && Object.hasOwn(value.value, 'content')) ||
    value.value.type === 'somevalue' ||
    value.value.type === 'novalue'
  );
}

function comparisonStatement(value: unknown, fieldFact = true): value is GameStatement {
  return (
    record(value) &&
    (!fieldFact || encodedBytes(value) <= 64 * 1024) &&
    typeof value.id === 'string' &&
    gameUuid.test(value.id) &&
    (value.rank === 'normal' || value.rank === 'preferred' || value.rank === 'deprecated') &&
    comparisonSnak(value) &&
    Array.isArray(value.qualifiers) &&
    (!fieldFact || value.qualifiers.length <= 64) &&
    value.qualifiers.every(comparisonSnak) &&
    Array.isArray(value.references) &&
    (!fieldFact || value.references.length <= 32) &&
    value.references.every(
      (reference) =>
        record(reference) &&
        typeof reference.hash === 'string' &&
        Array.isArray(reference.parts) &&
        (!fieldFact || reference.parts.length <= 64) &&
        reference.parts.every(comparisonSnak),
    ) &&
    record(value.rezics) &&
    typeof value.rezics.release === 'string' &&
    typeof value.rezics.revision === 'number' &&
    Number.isFinite(value.rezics.revision)
  );
}

function comparisonField(value: unknown, property: string): value is WorkReleaseCardField {
  if (!record(value) || typeof value.state !== 'string') return false;
  if (value.state !== 'available') return Object.hasOwn(comparisonEmptyStates, value.state);
  return (
    Array.isArray(value.statements) &&
    value.statements.length <= 32 &&
    value.statements.every((statement) => comparisonStatement(statement) && statement.property.id === property) &&
    comparisonRelated(value.related)
  );
}

/** A malformed optional HTTP comparison cannot retire an independently admitted membership window. */
function admitComparison(value: unknown, rows: Links['links'], work: string): WorkReleaseCards {
  const unavailable: WorkReleaseCards = { state: 'unavailable' };
  if (!record(value) || encodedBytes(value) > 2 * 1024 * 1024) return unavailable;
  if (value.state === 'unavailable') return value as WorkReleaseCards;
  if (value.state !== 'available' || !Array.isArray(value.cards) || value.cards.length > gameReaderLimit)
    return unavailable;
  const membership = new Map(rows.map((row, index) => [`${row.subject}:${row.statement}`, { row, index }]));
  let previous = -1;
  for (const card of value.cards) {
    if (
      !record(card) ||
      typeof card.subject !== 'string' ||
      typeof card.type !== 'string' ||
      !comparisonStatement(card.membership, false)
    )
      return unavailable;
    const admitted = membership.get(`${card.subject}:${card.membership.id}`);
    const fields = card.fields;
    if (
      !admitted?.row.assertion ||
      !admitted.row.summary ||
      admitted.index <= previous ||
      card.type !== admitted.row.summary.type ||
      !comparisonSummary(card.summary, card.subject) ||
      card.summary.type !== card.type ||
      card.membership.property.id !== editionProperty ||
      card.membership.value.type !== 'value' ||
      card.membership.value.content !== work ||
      !comparisonRelated(card.related) ||
      !record(fields) ||
      !Object.keys(comparisonProperties).every((property) => comparisonField(fields[property], property))
    )
      return unavailable;
    previous = admitted.index;
  }
  return value as WorkReleaseCards;
}
