import { parseListPresentation, type CoverSummary } from '@rezics/ui/cover';
import type {
  CollectionListPresentations,
  CollectionPresentationData,
  CollectionTypeOption,
} from '../collection-presentation';
import type { CollectionMember, LibrarySubject } from '../reads';

/** Exact command operands stay in the owning metadata draft, including unavailable selections. */
export type PresentationSelection = {
  kind: string | null;
  coverMediaId: string | null;
};

export type PresentationChoiceState = 'retained' | 'automatic' | 'replacement';

export function presentationChoiceState(saved: string | null, draft: string | null): PresentationChoiceState {
  return saved === draft ? 'retained' : draft === null ? 'automatic' : 'replacement';
}

export type TypeChoice = {
  id: string | null;
  state: PresentationChoiceState;
  availability: 'automatic' | 'released' | 'unavailable';
  label: string | null;
  presentation: ReturnType<typeof parseListPresentation>;
};

/** Type identity is a value, never a layout mode or a replacement for a member's Type. */
export function presentationTypeChoice(
  saved: string | null,
  draft: string | null,
  types: readonly CollectionTypeOption[] | null | undefined,
  presentations: CollectionListPresentations | undefined,
): TypeChoice {
  const option = draft === null ? undefined : types?.find((type) => type.id === draft);
  return {
    id: draft,
    state: presentationChoiceState(saved, draft),
    availability: draft === null ? 'automatic' : option ? 'released' : 'unavailable',
    label: option?.label || null,
    presentation: draft === null ? null : parseListPresentation(presentations?.[draft]),
  };
}

export type LoadedCoverOption = {
  mediaId: string;
  subject: LibrarySubject;
  cover: CoverSummary;
  /** The same cover can occur more than once; media selection does not collapse preview occurrences. */
  occurrences: readonly CollectionMember[];
};

/** Exactly the existing selector's eligibility, using only embedded covers from this page. */
export function loadedCoverOptions(members: readonly CollectionMember[]): LoadedCoverOption[] {
  const covers = new Map<string, LoadedCoverOption>();
  for (const member of members) {
    const subject = member.subject;
    const cover = subject?.cover;
    if (
      !subject ||
      !cover ||
      cover.withheld ||
      !cover.variants.some((variant) => variant.format === 'avif' || variant.format === 'webp')
    )
      continue;
    const existing = covers.get(cover.media);
    if (existing) {
      covers.set(cover.media, { ...existing, occurrences: [...existing.occurrences, member] });
    } else {
      covers.set(cover.media, { mediaId: cover.media, subject, cover, occurrences: [member] });
    }
  }
  return [...covers.values()];
}

export type DraftCoverPreview =
  | { kind: 'automatic'; nativeCover: CoverSummary | null; nativeSource: CollectionPresentationData['coverSource'] }
  | { kind: 'loaded'; option: LoadedCoverOption; state: PresentationChoiceState }
  | { kind: 'unavailable'; state: PresentationChoiceState };

/** Automatic is not simulated from the first local member; only native reading can resolve it. */
export function draftCoverPreview({
  saved,
  selected,
  nativeCover,
  nativeSource,
  options,
}: {
  saved: string | null;
  selected: string | null;
  nativeCover: CoverSummary | null;
  nativeSource: CollectionPresentationData['coverSource'];
  options: readonly LoadedCoverOption[];
}): DraftCoverPreview {
  if (selected === null)
    return {
      kind: 'automatic',
      nativeCover: saved === null ? nativeCover : null,
      nativeSource: saved === null ? nativeSource : undefined,
    };
  const option = options.find((candidate) => candidate.mediaId === selected);
  const state = presentationChoiceState(saved, selected);
  return option ? { kind: 'loaded', option, state } : { kind: 'unavailable', state };
}

export type LoadedTypeContext = {
  type: string;
  label: string | null;
  occurrences: number;
  presentation: ReturnType<typeof parseListPresentation>;
};

/** Counts describe the received occurrence page, never the Collection's distribution. */
export function loadedTypeContexts(
  members: readonly CollectionMember[],
  types: readonly CollectionTypeOption[] | null | undefined,
  presentations: CollectionListPresentations | undefined,
): { types: LoadedTypeContext[]; unavailable: number } {
  const contexts = new Map<string, LoadedTypeContext>();
  let unavailable = 0;
  for (const { subject } of members) {
    if (!subject) {
      unavailable += 1;
      continue;
    }
    const previous = contexts.get(subject.type);
    contexts.set(subject.type, {
      type: subject.type,
      label: types?.find((type) => type.id === subject.type)?.label || subject.typeLabel || null,
      occurrences: (previous?.occurrences ?? 0) + 1,
      presentation: parseListPresentation(presentations?.[subject.type]),
    });
  }
  return { types: [...contexts.values()], unavailable };
}

/** Only these two parts belong to this review; unrelated metadata never affects these flags. */
export function presentationChanges(saved: PresentationSelection, draft: PresentationSelection) {
  return {
    type: saved.kind !== draft.kind,
    cover: saved.coverMediaId !== draft.coverMediaId,
  };
}

/** Labels stay separate from command identity and never guess a title for absent media. */
export function loadedCoverSubject(id: string | null, options: readonly LoadedCoverOption[]): LibrarySubject | null {
  return id === null ? null : (options.find((option) => option.mediaId === id)?.subject ?? null);
}

export type LoadedCoverAvailability = {
  eligible: number;
  withheld: number;
  missing: number;
  unsupported: number;
  unavailable: number;
};

/** Explain absent options using embedded response facts only; a failed image load does not grant a new option. */
export function loadedCoverAvailability(members: readonly CollectionMember[]): LoadedCoverAvailability {
  const result: LoadedCoverAvailability = { eligible: 0, withheld: 0, missing: 0, unsupported: 0, unavailable: 0 };
  for (const { subject } of members) {
    if (!subject) result.unavailable += 1;
    else if (!subject.cover) result.missing += 1;
    else if (subject.cover.withheld) result.withheld += 1;
    else if (!subject.cover.variants.some((variant) => variant.format === 'avif' || variant.format === 'webp'))
      result.unsupported += 1;
    else result.eligible += 1;
  }
  return result;
}
