import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { episodeMembershipProperty } from '../screen-episode-membership';
import { readScreenProfile, type ScreenRead } from '../screen-profile';
import { WORK_PARTS_PAGE_CAP, partStreams, type PartRow } from '../work-parts';

type Endpoint = ReturnType<KernelClient['subjects']>;
type LinkPage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;
type Part = Pick<PartRow, 'summary' | 'statementId'> & { statement?: PartRow['statement'] };

export type ScreenEpisodeEntry = {
  membershipId: string;
  id: string;
  type: 'schema:Episode' | 'schema:TVSeason';
  label?: string;
  language?: string;
  typeLabel: { text: string; lang: string | null };
  position?: string;
};

export type ScreenEpisodeRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'stale' | 'unavailable' }
  | { ok: true; state: 'empty' | 'ready' | 'withheld'; entries: ScreenEpisodeEntry[]; next: string | null };

export type ScreenProfileReaderLoad = { profile: ScreenRead; episodes?: ScreenEpisodeRead };

type PageCount = { value: number; exact?: boolean } | undefined;

function rowEntries(rows: readonly Part[], parentType: string, release: Release, locale: string, positionAllowed: boolean) {
  return rows.flatMap((row): ScreenEpisodeEntry[] => {
    const summary = row.summary;
    if (!summary || !summary.id) return [];
    const type = summary.type;
    if (type !== 'schema:Episode' && (parentType !== 'schema:TVSeries' || type !== 'schema:TVSeason')) return [];
    const nativePosition = positionAllowed
      ? row.statement?.qualifiers.find((part) => part.property.id === 'schema:position')
      : undefined;
    const position =
      nativePosition?.value.type === 'value' && typeof nativePosition.value.content === 'string'
        ? nativePosition.value.content
        : undefined;
    return [
      {
        membershipId: row.statementId,
        id: summary.id,
        type,
        ...(summary.label?.value ? { label: summary.label.value } : {}),
        ...(summary.label?.language ? { language: summary.label.language } : {}),
        typeLabel: pickText(release.types[type]?.labels ?? {}, locale),
        ...(position === undefined ? {} : { position }),
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
  if (!count || !Number.isSafeInteger(count.value) || count.value < 0)
    return { ok: false, reason: 'unavailable' };
  if (!cursor && !entries.length && !rowCount && !next && count.exact === true && count.value === 0)
    return { ok: true, state: 'empty', entries, next };
  const withheld =
    (!entries.length && (rowCount > 0 || next !== null || cursor !== undefined)) ||
    entries.length < rowCount ||
    (!cursor && next === null && count.value > rowCount);
  return { ok: true, state: withheld ? 'withheld' : 'ready', entries, next };
}

function failed(status: number): ScreenEpisodeRead {
  if (status === 400 || status === 409) return { ok: false, reason: 'stale' };
  if (status === 403 || status === 404 || status === 308) return { ok: false, reason: 'concealed' };
  return { ok: false, reason: 'unavailable' };
}

/** Read one current work-parts page. Membership and member labels come only from the installed Semantic response. */
export async function readScreenEpisodePage(
  client: KernelClient,
  release: Release,
  parent: SubjectRead,
  locale: string,
  context?: string,
  cursor?: string,
): Promise<ScreenEpisodeRead> {
  const parentType = parent.subject.type;
  if (parentType !== 'schema:TVSeries' && parentType !== 'schema:TVSeason')
    return { ok: false, reason: 'invalid' };
  const streams = partStreams(release, parentType, locale);
  const stream =
    streams.find((candidate) => candidate.direction === 'inverse' && candidate.property === episodeMembershipProperty) ??
    streams[0];
  if (!stream) return { ok: false, reason: 'unavailable' };
  const definition = release.properties[stream.property];
  if (!definition?.relation) return { ok: false, reason: 'unavailable' };
  const positionAllowed =
    definition.qualifiers.includes('schema:position') && release.properties['schema:position']?.datatype === 'string';
  const query = {
    property: stream.property,
    language: locale,
    limit: WORK_PARTS_PAGE_CAP,
    ...(context ? { context } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const fetch = { cache: 'no-store' as const, redirect: 'manual' as const };
  try {
    if (stream.direction === 'inverse') {
      const result = await client.subjects({ id: parent.subject.id }).links.get({ query, fetch });
      if (result.status !== 200 || !result.data) return failed(result.status);
      const rows: Part[] = result.data.links.map((row) => ({
        statementId: row.statement,
        summary: row.summary,
        ...(row.assertion ? { statement: row.assertion } : {}),
      }));
      return pageState(
        rowEntries(rows, parentType, release, locale, positionAllowed),
        rows.length,
        result.data.count,
        result.data.next,
        cursor,
      );
    }
    const result = await client.subjects({ id: parent.subject.id }).relations.get({ query, fetch });
    if (result.status !== 200 || !result.data) return failed(result.status);
    const rows: Part[] = result.data.relations.map((row) => ({
      statementId: row.statement.id,
      summary: row.summary,
      statement: row.statement,
    }));
    return pageState(
      rowEntries(rows, parentType, release, locale, positionAllowed),
      rows.length,
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

