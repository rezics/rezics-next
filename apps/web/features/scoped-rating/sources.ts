import { direction } from '@rezics/main/language';
import type { EntityPickerItem, EntityPickerLoad } from '@rezics/ui/entity-picker';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { pickPositionLabel, readReadingPositionPage } from '../wiki/position-picker.ts';
import { idOf } from '../work-page/route.ts';
import type { FrameCandidate, FrameDimension } from './frames.ts';

/** One choice in a frame picker: what the picker lists, and the frame choosing it adds. */
export interface FrameOption extends EntityPickerItem {
  candidate: FrameCandidate;
}

/** A list of places of one kind a person can choose from. The picker offers one tab per source. */
export interface FrameSource {
  /** Tells two sources of one dimension apart (the episodes of two Works); the dimension itself where absent. */
  id?: string;
  dimension: FrameDimension;
  /** Names the kind in the host's words ("Episodes", "Maps"); the dimension's own name where absent. */
  label?: string;
  load: EntityPickerLoad<FrameOption>;
}

const option = (candidate: FrameCandidate): FrameOption => ({ value: candidate.iri, label: candidate.name.value, candidate });

/** A short list the host already has (a franchise's continuities, an event's maps), searched here by name. */
export function staticFrameSource(dimension: FrameDimension, candidates: readonly FrameCandidate[], label?: string, id?: string): FrameSource {
  return { id, dimension, label, async load({ q }) {
    const needle = q.trim().toLocaleLowerCase();
    const items = candidates.filter(item => !needle || item.name.value.toLocaleLowerCase().includes(needle)).map(option);
    return { items, nextCursor: null, complete: true };
  } };
}

/**
 * The chapters or episodes of a Work, from Main's reading order: Main searches every language it carries and applies
 * disclosure before the page bound, so a place the reader has not reached never appears here.
 */
export function readingPositionSource({ work, actingSubject, position, locale, label, main = () => browserMainApi(undefined, { anonymous: !actingSubject }) }: {
  work: string; actingSubject?: string; position?: string; locale: UiLocale; label?: string; main?: () => MainClient;
}): FrameSource {
  return { id: `position:${work}`, dimension: 'position', label, async load({ q, cursor }) {
    const page = await readReadingPositionPage(main(),
      { work, actingSubject, position, q, cursor: cursor ?? undefined, limit: 20, language: locale });
    return { nextCursor: page.nextCursor, complete: page.complete, updating: page.search?.status === 'indexing',
      items: page.items.map(item => {
        const text = pickPositionLabel(item.labels, locale);
        const value = text?.value ?? item.displayLabel ?? (item.ordinal ? String(item.ordinal) : item.occurrence.slice(-8));
        return option({ iri: item.occurrence, work,
          dimension: 'position', name: { value, language: text?.lang ?? '', direction: text?.dir ?? direction('', value) } });
      }) };
  } };
}

/** The releases of a Work (its game versions and editions as published), newest page first, searched here by title. */
export function releaseSource({ work, actingSubject, label, main = () => browserMainApi(undefined, { anonymous: !actingSubject }) }: {
  work: string; actingSubject?: string; label?: string; main?: () => MainClient;
}): FrameSource {
  const id = idOf(work);
  return { id: `release:${work}`, dimension: 'release', label, async load({ q, cursor }) {
    if (!id) return { items: [], nextCursor: null, complete: true };
    const { data } = await main().v1.works({ id }).releases.get({ query: { limit: 20, ...cursor ? { cursor } : {}, ...actingSubject ? { actingSubject } : {} } });
    const needle = q.trim().toLocaleLowerCase();
    const items = (data?.items ?? []).filter(release => !needle || release.title.value.toLocaleLowerCase().includes(needle)).map(release =>
      option({ iri: release.id, dimension: 'release', work, name: { value: release.title.value, language: release.title.language,
        direction: direction(release.title.language, release.title.value) } }));
    return { items, nextCursor: data?.nextCursor ?? null, complete: !data?.nextCursor };
  } };
}

/** At most this many events are followed up from a subject, and this many of their parts and earlier places read. */
const MAX_CONTAINERS = 6;
const MAX_PARTS = 24;

/**
 * The matches and events of a subject: those its own statements name, the events it has already been rated in, and, where
 * Main's reverse statement read answers, the parts of those events (a map belongs to a match, and a player takes part in the
 * match). Only what Main returns for the person is offered; the reverse read is best effort, so a subject can always be rated
 * again in a place it already has.
 */
export function relatedEventSource({ subject, actingSubject, label, main = () => browserMainApi(undefined, { anonymous: !actingSubject }) }: {
  subject: string; actingSubject?: string; label?: string; main?: () => MainClient;
}): FrameSource {
  const reader = actingSubject ? { actingSubject } : {};
  const candidate = async (iri: string): Promise<FrameCandidate | null> => {
    const id = idOf(iri);
    if (!id) return null;
    const { data } = await main().v1.resources({ resource: id }).page.get({ query: reader });
    if (data?.registry.frameDimension !== 'event' || data.summary.status !== 'available') return null;
    return { iri, dimension: 'event', name: { value: data.summary.name.value, language: data.summary.name.language,
      direction: data.summary.name.direction } };
  };
  let found: Promise<FrameCandidate[]> | null = null;
  const find = async (): Promise<FrameCandidate[]> => {
    const id = idOf(subject);
    if (!id) return [];
    const [statements, rated] = await Promise.all([
      main().v1.resources({ resource: id }).statements.get({ query: reader }),
      main().v1.projections.get({ query: { subject, limit: 20, ...reader } }),
    ]);
    const values = [...new Set((statements.data?.groups ?? []).flatMap(group => group.items.flatMap(item =>
      item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : [])))].slice(0, MAX_CONTAINERS);
    const containers = (await Promise.all(values.map(candidate))).flatMap(item => item ? [item] : []);
    const parts: string[] = (rated.data?.items ?? []).flatMap(item => item.frames);
    if (actingSubject) {
      for (const container of containers) {
        const incoming = await main().v1.graph.queries.post({ profile: 'statement-graph-v1', actingSubject,
          anchor: container.iri, direction: 'incoming' });
        if (incoming.data && 'claims' in incoming.data) parts.push(...incoming.data.claims.map(claim => claim.subject));
      }
    }
    const known = new Set(containers.map(item => item.iri));
    const nested = (await Promise.all([...new Set(parts)].filter(iri => !known.has(iri)).slice(0, MAX_PARTS).map(candidate)))
      .flatMap(item => item ? [item] : []);
    return [...containers, ...nested];
  };
  return { id: `event:${subject}`, dimension: 'event', label, async load({ q }) {
    found ??= find().catch(() => []);
    const needle = q.trim().toLocaleLowerCase();
    const items = (await found).filter(item => !needle || item.name.value.toLocaleLowerCase().includes(needle)).map(option);
    return { items, nextCursor: null, complete: true };
  } };
}
