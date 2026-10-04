import type { EntityPickerItem, EntityPickerLoad } from '@rezics/ui/entity-picker';
import { browserMainApi } from '../api/browser.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { pickPositionLabel, readReadingPositionPage } from '../wiki/position-picker.ts';
import type { FrameCandidate, FrameDimension } from './frames.ts';

/** One choice in a frame picker: what the picker lists, and the frame choosing it adds. */
export interface FrameOption extends EntityPickerItem {
  candidate: FrameCandidate;
}

/** A list of places of one kind a person can choose from. The picker offers one tab per source. */
export interface FrameSource {
  dimension: FrameDimension;
  /** Names the kind in the host's words ("Episodes", "Maps"); the dimension's own name where absent. */
  label?: string;
  load: EntityPickerLoad<FrameOption>;
}

const option = (candidate: FrameCandidate): FrameOption => ({ value: candidate.iri, label: candidate.name.value, candidate });

/** A short list the host already has (a franchise's continuities, an event's maps), searched here by name. */
export function staticFrameSource(dimension: FrameDimension, candidates: readonly FrameCandidate[], label?: string): FrameSource {
  return { dimension, label, async load({ q }) {
    const needle = q.trim().toLocaleLowerCase();
    const items = candidates.filter(item => !needle || item.name.value.toLocaleLowerCase().includes(needle)).map(option);
    return { items, nextCursor: null, complete: true };
  } };
}

/**
 * The chapters or episodes of a Work, from Main's reading order: Main searches every language it carries and applies
 * disclosure before the page bound, so a place the reader has not reached never appears here.
 */
export function readingPositionSource({ work, actingSubject, locale, label }: {
  work: string; actingSubject?: string; locale: UiLocale; label?: string;
}): FrameSource {
  return { dimension: 'position', label, async load({ q, cursor }) {
    const page = await readReadingPositionPage(browserMainApi(undefined, { anonymous: !actingSubject }),
      { work, actingSubject, q, cursor: cursor ?? undefined, limit: 20, language: locale });
    return { nextCursor: page.nextCursor, complete: page.complete, updating: page.search?.status === 'indexing',
      items: page.items.map(item => {
        const text = pickPositionLabel(item.labels, locale);
        const value = text?.value ?? item.displayLabel ?? (item.ordinal ? String(item.ordinal) : item.occurrence.slice(-8));
        return option({ iri: item.occurrence,
          dimension: 'position', name: { value, language: text?.lang ?? '', direction: text?.dir ?? 'ltr' } });
      }) };
  } };
}
