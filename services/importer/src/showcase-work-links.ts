import type { SourceRecord } from '@rezics/conversion';
import { vndbLimits } from '@rezics/conversion/vndb';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { citedProviderBinding, type GraphEdgeDraft } from './cross-media-bindings.ts';

type Row = Record<string, unknown>;
export const vndbWorkLinkConverterRevision = 'vndb-work-links@1';

export type SelectedVndbWorkJoin = {
  join: { id: string; link: number };
  raw: Row;
};

export type SelectedVndbWorkDictionaryRow = {
  value: { id: number; site: string; value: string };
  raw: Row;
};

export type ShowcaseWorkLink = {
  owner: string;
  linkId: number;
  site: string;
  value: string;
  candidateDigest: string;
  semanticDigest: string;
  bangumiExternalId?: string;
  bridgeReason?: string;
};

export type ShowcaseWorkLinkGap = {
  owner: string;
  linkId: number;
  record: Row;
  reason: string;
};

export type CurrentWorkRead = { subjectId: string; route: string };
export type ShowcaseWorkLinkHandoff = {
  source: { provider: 'vndb'; externalId: string; subject?: CurrentWorkRead };
  sourceLink: { id: number; site: string; value: string };
  candidateDigest: string;
  semanticDigest: string;
  reference:
    | { status: 'unsupported'; reason: string }
    | { status: 'unresolved'; provider: 'bangumi'; externalId: string }
    | { status: 'current'; provider: 'bangumi'; externalId: string; subject: CurrentWorkRead };
};

type BangumiWorkIdAdmission = { status: 'admitted'; id: string } | { status: 'unsupported'; reason: string };

function admittedBangumiWorkId(site: string, value: string): BangumiWorkIdAdmission {
  if (site !== 'website')
    return { status: 'unsupported', reason: 'VNDB external-link site does not admit a public website assertion' };
  const cited = citedProviderBinding(value);
  if (cited?.provider !== 'bangumi')
    return { status: 'unsupported', reason: 'Source website does not cite an admitted Bangumi work' };
  if (!/^[1-9][0-9]*$/.test(cited.key) || !Number.isSafeInteger(Number(cited.key)))
    return { status: 'unsupported', reason: 'Cited Bangumi identifier is not a work identity' };
  return { status: 'admitted', id: cited.key };
}

/** Join only bounded selected VN rows to their exact dictionary entries. */
export function attachShowcaseWorkLinks(input: {
  alias: string;
  records: readonly SourceRecord[];
  joins: ReadonlyMap<string, readonly SelectedVndbWorkJoin[]>;
  dictionary: ReadonlyMap<number, SelectedVndbWorkDictionaryRow>;
}): {
  records: SourceRecord[];
  links: ShowcaseWorkLink[];
  edges: GraphEdgeDraft[];
  gaps: ShowcaseWorkLinkGap[];
} {
  const records: SourceRecord[] = [];
  const links: ShowcaseWorkLink[] = [];
  const edges: GraphEdgeDraft[] = [];
  const gaps: ShowcaseWorkLinkGap[] = [];

  for (const record of input.records) {
    const selected = input.joins.get(record.key);
    if (!selected?.length) {
      records.push(record);
      continue;
    }
    if (selected.length > vndbLimits.maxLinks) {
      gaps.push({
        owner: record.key,
        linkId: selected[vndbLimits.maxLinks]!.join.link,
        record: { id: record.key, link: selected[vndbLimits.maxLinks]!.join.link },
        reason: 'Selected VNDB work external links exceed the converter limit',
      });
      records.push(record);
      continue;
    }

    const ordered = [...selected].sort((left, right) => left.join.link - right.join.link);
    const pairs = ordered.map((entry) => ({ entry, dictionary: input.dictionary.get(entry.join.link) }));
    const missing = pairs.filter((pair) => pair.dictionary === undefined);
    for (const pair of missing)
      gaps.push({
        owner: record.key,
        linkId: pair.entry.join.link,
        record: { id: record.key, link: pair.entry.join.link },
        reason: 'Selected VNDB work external-link dictionary row is missing',
      });
    if (missing.length) {
      records.push(record);
      continue;
    }

    const joins = ordered.map(({ join }) => join);
    const dictionary = pairs.map((pair) => pair.dictionary!.value);
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new TypeError('Selected VNDB work payload is not a record');
    records.push({
      ...record,
      payload: { ...payload, vn_extlinks: joins, extlinks: dictionary },
    });

    for (const pair of pairs) {
      const join = pair.entry.join;
      const external = pair.dictionary!;
      const rawSourceRecord = { vn_extlinks: pair.entry.raw, extlinks: external.raw };
      const semanticSourceRecord = { vn_extlinks: join, extlinks: external.value };
      const reference = admittedBangumiWorkId(external.value.site, external.value.value);
      const item: ShowcaseWorkLink = {
        owner: record.key,
        linkId: join.link,
        site: external.value.site,
        value: external.value.value,
        candidateDigest: sourceDigest(rawSourceRecord),
        semanticDigest: sourceDigest(semanticSourceRecord),
        ...(reference.status === 'unsupported'
          ? { bridgeReason: reference.reason }
          : { bangumiExternalId: reference.id }),
      };
      links.push(item);
      if (reference.status === 'admitted')
        edges.push({
          source: 'vndb',
          alias: input.alias,
          table: 'extlinks',
          holder: record.key,
          target: reference.id,
          property: 'wdt:P5732',
          url: external.value.value,
          targetKind: 'literal',
          membership: 'referenced',
          record: rawSourceRecord,
          fields: ['vn_extlinks.id', 'vn_extlinks.link', 'extlinks.id', 'extlinks.site', 'extlinks.value'],
          recordRevision: record.revision ?? 'unversioned',
          converterRevision: vndbWorkLinkConverterRevision,
          fenceFacts: true,
        });
    }
  }

  links.sort((left, right) => left.owner.localeCompare(right.owner) || left.linkId - right.linkId);
  edges.sort((left, right) => left.holder.localeCompare(right.holder) || left.target.localeCompare(right.target));
  gaps.sort((left, right) => left.owner.localeCompare(right.owner) || left.linkId - right.linkId);
  return { records, links, edges, gaps };
}

export function resolveShowcaseWorkLinkHandoffs(
  links: readonly ShowcaseWorkLink[],
  reads: ReadonlyMap<string, CurrentWorkRead>,
): ShowcaseWorkLinkHandoff[] {
  const result = links.map((link): ShowcaseWorkLinkHandoff => {
    const source = reads.get('vndb\u0000' + link.owner);
    const sourceValue = {
      provider: 'vndb' as const,
      externalId: link.owner,
      ...(source ? { subject: source } : {}),
    };
    const sourceLink = { id: link.linkId, site: link.site, value: link.value };
    if (link.bangumiExternalId === undefined)
      return {
        source: sourceValue,
        sourceLink,
        candidateDigest: link.candidateDigest,
        semanticDigest: link.semanticDigest,
        reference: { status: 'unsupported', reason: link.bridgeReason ?? 'No admitted Bangumi work identifier' },
      };
    const externalId = link.bangumiExternalId;
    const target = reads.get('bangumi\u0000' + externalId);
    return {
      source: sourceValue,
      sourceLink,
      candidateDigest: link.candidateDigest,
      semanticDigest: link.semanticDigest,
      reference: target
        ? { status: 'current', provider: 'bangumi', externalId, subject: target }
        : { status: 'unresolved', provider: 'bangumi', externalId },
    };
  });
  return result;
}
