import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { gameGroups, gameType, gameUuid, type GameGroup } from '../game-profile';
import type { GuideRelease } from '../definition-guide';
import { isA, selectedStatements, encodedBytes } from '../release-fidelity/model';

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
      editionTypes: string[];
      editionsAdmitted: boolean;
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
      client.subjects({ id: address.id }).get({ query: { context: address.context, language: locale } }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    const read = current.data;
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
    // The links owner currently reports both stale and invalid cursors as invalid_request.
    // Neither means that the native stream is exhausted or that retrying the token will help.
    if (response.status === 400 && address.cursor) return { ok: false, reason: 'restart' };
    if (response.status !== 200 || !response.data) return failure(response.status);
    const page = response.data;
    if (
      page.links.length > gameReaderLimit ||
      encodedBytes(page) > gameReaderLimit * 128 * 1024 + 64 * 1024 ||
      (page.next !== null &&
        (typeof page.next !== 'string' || !page.next.length || page.next.length > 4096 || page.next === address.cursor))
    )
      return { ok: false, reason: 'unavailable' };
    const seen = new Set<string>();
    for (const row of page.links) {
      const key = `${row.subject}:${row.statement}`;
      if (
        encodedBytes(row) > 128 * 1024 ||
        seen.has(key) ||
        !gameUuid.test(row.subject) ||
        !gameUuid.test(row.statement) ||
        row.property !== editionProperty ||
        (row.summary && row.summary.id !== row.subject) ||
        (row.assertion &&
          (row.assertion.id !== row.statement ||
            row.assertion.property.id !== editionProperty ||
            row.assertion.value.type !== 'value' ||
            row.assertion.value.content !== address.id))
      )
        return { ok: false, reason: 'unavailable' };
      seen.add(key);
    }
    return { ...common, editions: page.links, next: page.next, caughtUp: page.freshness.caught_up };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
