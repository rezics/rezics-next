import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { episodeMembershipProperty } from '../screen-episode-membership';
import { readScreenProfile, type ScreenRead } from '../screen-profile';
import { WORK_PARTS_PAGE_CAP, partStreams } from '../work-parts';

type Endpoint = ReturnType<KernelClient['subjects']>;
type LinkPage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type LinkRow = LinkPage['links'][number];
type MembershipStatement = NonNullable<LinkRow['assertion']>;

/** The native links route has no aggregate wire-byte ceiling; bound retained adapter data to 1 MiB. */
export const SCREEN_EPISODE_PAGE_MAX_BYTES = 1_048_576;

export type ScreenEpisodeEntry = {
  membershipId: string;
  holderId: string;
  parentId: string;
  context: string;
  id: string;
  type: 'schema:Episode' | 'schema:TVSeason';
  label?: string;
  language?: string;
  typeLabel: { text: string; lang: string | null };
  position?: string;
  statement?: MembershipStatement;
  related?: SubjectRead['related'];
};

export type ScreenEpisodeRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'stale' | 'unavailable' | 'unsupported' }
  | { ok: true; state: 'empty' | 'ready' | 'withheld'; entries: ScreenEpisodeEntry[]; next: string | null };

export type ScreenProfileReaderLoad = { profile: ScreenRead; episodes?: ScreenEpisodeRead };

type PageCount = LinkPage['count'];

function pageWithinBudget(page: LinkPage): boolean {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(page));
    return encoded.byteLength <= SCREEN_EPISODE_PAGE_MAX_BYTES;
  } catch {
    return false;
  }
}

function rowEntries(
  rows: readonly LinkRow[],
  parentId: string,
  parentType: string,
  context: string,
  release: Release,
  locale: string,
) {
  return rows.flatMap((row): ScreenEpisodeEntry[] => {
    const summary = row.summary;
    const holderId = row.subject;
    if (!summary?.id || summary.id !== holderId || row.property !== episodeMembershipProperty) return [];
    const type = summary.type;
    if (type !== 'schema:Episode' && (parentType !== 'schema:TVSeries' || type !== 'schema:TVSeason')) return [];

    const statement = row.assertion;
    if (
      statement &&
      (statement.id !== row.statement ||
        statement.property.id !== row.property ||
        statement.value.type !== 'value' ||
        statement.value.content !== parentId)
    )
      return [];

    const nativePosition = statement?.qualifiers.find((part) => part.property.id === 'schema:position');
    const positionAllowed =
      release.properties[episodeMembershipProperty]?.qualifiers.includes('schema:position') === true &&
      release.properties['schema:position']?.datatype === 'string';
    const position =
      positionAllowed && nativePosition?.value.type === 'value' && typeof nativePosition.value.content === 'string'
        ? nativePosition.value.content
        : undefined;
    const related = row.related
      ? Object.fromEntries(
          Object.entries(row.related).map(([id, value]) => [
            id,
            { type: value.type, labels: value.label ? { [value.label.language]: value.label.value } : {} },
          ]),
        )
      : undefined;

    return [
      {
        membershipId: row.statement,
        holderId,
        parentId,
        context,
        id: summary.id,
        type,
        ...(summary.label?.value ? { label: summary.label.value } : {}),
        ...(summary.label?.language ? { language: summary.label.language } : {}),
        typeLabel: pickText(release.types[type]?.labels ?? {}, locale),
        ...(position === undefined ? {} : { position }),
        ...(statement ? { statement } : {}),
        ...(related ? { related } : {}),
      },
    ];
  });
}

function pageState(
  entries: ScreenEpisodeEntry[],
  rowCount: number,
  count: PageCount,
  next: string | null,
  cursor: string | undefined,
): ScreenEpisodeRead {
  if (count && (!Number.isSafeInteger(count.value) || count.value < 0)) return { ok: false, reason: 'unavailable' };
  if (next !== null && (!next.length || next.length > 8192)) return { ok: false, reason: 'unavailable' };
  if (!cursor && entries.length === 0 && rowCount === 0 && next === null && (count === undefined || count.value === 0))
    return { ok: true, state: 'empty', entries, next };
  const withheld =
    entries.some((entry) => !entry.statement) ||
    entries.length < rowCount ||
    (!cursor && next === null && count !== undefined && count.value > rowCount);
  return { ok: true, state: withheld ? 'withheld' : 'ready', entries, next };
}

function failed(status: number): ScreenEpisodeRead {
  if (status === 400 || status === 409) return { ok: false, reason: 'stale' };
  if (status === 403 || status === 404 || status === 308) return { ok: false, reason: 'concealed' };
  return { ok: false, reason: 'unavailable' };
}

/** Read one current inverse-membership window and retain only the exact returned membership evidence. */
export async function readScreenEpisodePage(
  client: KernelClient,
  release: Release,
  parent: SubjectRead,
  locale: string,
  context?: string,
  cursor?: string,
): Promise<ScreenEpisodeRead> {
  const parentType = parent.subject.type;
  if (parentType !== 'schema:TVSeries' && parentType !== 'schema:TVSeason') return { ok: false, reason: 'invalid' };
  const stream = partStreams(release, parentType, locale).find(
    (candidate) => candidate.direction === 'inverse' && candidate.property === episodeMembershipProperty,
  );
  if (!stream) return { ok: false, reason: 'unsupported' };
  const definition = release.properties[stream.property];
  if (!definition?.relation) return { ok: false, reason: 'unsupported' };
  const query = {
    property: stream.property,
    language: locale,
    limit: WORK_PARTS_PAGE_CAP,
    ...(context ? { context } : {}),
    ...(cursor ? { cursor } : {}),
  };
  try {
    const result = await client.subjects({ id: parent.subject.id }).links.get({
      query,
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.status !== 200 || !result.data) return failed(result.status);
    if (result.data.links.length > WORK_PARTS_PAGE_CAP || !pageWithinBudget(result.data))
      return { ok: false, reason: 'unavailable' };
    return pageState(
      rowEntries(result.data.links, parent.subject.id, parentType, parent.subject.context, release, locale),
      result.data.links.length,
      result.data.count,
      result.data.next,
      cursor,
    );
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export async function readScreenProfileForReader(
  client: KernelClient,
  input: { id: string; expectedType: string; locale: string; context?: string; cursor?: string },
): Promise<ScreenProfileReaderLoad> {
  const profile = await readScreenProfile(client, {
    id: input.id,
    ...(input.context ? { context: input.context } : {}),
  });
  if (input.expectedType !== 'schema:TVSeries' && input.expectedType !== 'schema:TVSeason') return { profile };
  if (!profile.ok)
    return {
      profile,
      episodes: { ok: false, reason: profile.reason },
    };
  if (!profile.public) return { profile, episodes: { ok: false, reason: 'unavailable' } };
  if (profile.public.subject.id !== input.id || profile.public.subject.type !== input.expectedType)
    return { profile, episodes: { ok: false, reason: 'stale' } };
  return {
    profile,
    episodes: await readScreenEpisodePage(
      client,
      profile.release,
      profile.public,
      input.locale,
      input.context,
      input.cursor,
    ),
  };
}
