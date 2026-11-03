import type { Release } from '@rezics/definitions';
import { subjectHref } from '../../subject/subject-href';
import type { CreateResult, CreatedReader } from './create-subject';
import type { StatementInput } from './statement-editor';
import type { PartRow } from './work-parts';

export const episodeType = 'schema:Episode';
export const episodeMembershipProperty = 'schema:isPartOf';
export const seriesUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MembershipDraft = { target: string; position: string };
export type EpisodeJourney =
  | { stage: 'edit' }
  | { stage: 'created'; id: string; reader: CreatedReader }
  | { stage: 'unread'; id: string }
  | { stage: 'unlinked'; id: string; reader: CreatedReader }
  | { stage: 'linked'; id: string; reader: CreatedReader };

/** Ignore unrelated route text; only an exact UUID may name a series or created child. */
export function screenSeriesId(value: unknown): string | undefined {
  return typeof value === 'string' && seriesUuid.test(value) ? value : undefined;
}

function isType(release: Pick<Release, 'types'>, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

export function episodeMembershipAdmission(release: Pick<Release, 'types' | 'properties'>, seriesType?: string) {
  const property = release.properties[episodeMembershipProperty];
  const admitted = !!release.types[episodeType]?.properties.includes(episodeMembershipProperty) && !!property?.relation;
  const positionAdmitted =
    admitted &&
    !!property?.qualifiers.includes('schema:position') &&
    release.properties['schema:position']?.datatype === 'string';
  const seriesAdmitted =
    !!seriesType &&
    admitted &&
    !!property?.targets?.some((target) => target === seriesType || isType(release, seriesType, target));
  return { property: episodeMembershipProperty, admitted, positionAdmitted, seriesAdmitted };
}

export function seriesEpisodeEntry(release: Pick<Release, 'types' | 'properties'>, type: string): boolean {
  return isType(release, type, 'schema:TVSeries') && episodeMembershipAdmission(release, type).seriesAdmitted;
}

/** Membership enters POST only when the contributor confirmed it and Episode creation admits the property and target. */
export function membershipCreateStatement(
  release: Pick<Release, 'types' | 'properties'>,
  seriesType: string | undefined,
  draft: MembershipDraft | undefined,
): StatementInput | undefined {
  if (!draft) return;
  const admission = episodeMembershipAdmission(release, seriesType);
  if (!admission.admitted || !admission.seriesAdmitted || !seriesUuid.test(draft.target)) return;
  const position = draft.position.trim();
  return {
    property: { id: episodeMembershipProperty },
    value: { type: 'value', content: draft.target },
    qualifiers:
      admission.positionAdmitted && position
        ? [{ property: { id: 'schema:position' }, value: { type: 'value', content: position } }]
        : [],
    references: [],
    rank: 'normal',
  };
}

export function seriesPartsHref(
  series: { id: string; label: string },
  locale: string,
  child?: string | undefined,
): string {
  const href = `${subjectHref(series, locale).href}/work-parts`;
  const id = screenSeriesId(child);
  return id ? `${href}?child=${encodeURIComponent(id)}` : href;
}

export function locateCreatedChild(rows: PartRow[], child: string): PartRow | undefined {
  const id = screenSeriesId(child);
  return id ? rows.find((row) => row.holder === id || row.summary?.id === id) : undefined;
}

export function episodeJourneyFromCreate(
  result: Extract<CreateResult, { ok: true }>,
  membership: MembershipDraft | undefined,
  includedInCreate: boolean,
): Exclude<EpisodeJourney, { stage: 'edit' }> {
  if (result.reader.state !== 'ready') return { stage: 'unread', id: result.id };
  if (membership && !includedInCreate) return { stage: 'unlinked', id: result.id, reader: result.reader };
  return { stage: 'created', id: result.id, reader: result.reader };
}

export function markEpisodeLinked(
  journey: Exclude<EpisodeJourney, { stage: 'edit' }>,
): Exclude<EpisodeJourney, { stage: 'edit' }> {
  if (journey.stage === 'unread') return journey;
  if (!('reader' in journey) || journey.reader.state !== 'ready') return journey;
  return { stage: 'linked', id: journey.id, reader: journey.reader };
}
