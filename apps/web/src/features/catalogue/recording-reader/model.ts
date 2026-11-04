import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { ProfileBound } from '../music-reader';

export const recordingType = 'schema:MusicRecording';

export type RecordingReaderState = 'ready' | 'empty' | 'loading' | 'unsupported' | 'unavailable' | 'invalid';
export type RecordingGroup = 'details' | 'contributions' | 'associations';
export type RecordingFact = SubjectRead['subject']['statements'][string][number];
export type RecordingField = {
  property: string;
  label: { text: string; lang: string | null };
  definition: PropertyDefinition;
  facts: RecordingFact[];
};
export type RecordingVisit = {
  state: RecordingReaderState;
  type: typeof recordingType;
  grain: { text: string; lang: string | null };
  groups: Record<RecordingGroup, RecordingField[]>;
  bounds: ProfileBound[];
};

const identityProperties = new Set([
  'schema:name',
  'schema:description',
  'schema:alternateName',
  'schema:image',
  'schema:sameAs',
]);

function emptyGroups(): Record<RecordingGroup, RecordingField[]> {
  return { details: [], contributions: [], associations: [] };
}

function visitState(
  state: RecordingReaderState,
  grain: { text: string; lang: string | null } = { text: '', lang: null },
  bounds: readonly ProfileBound[] = [],
): RecordingVisit {
  return {
    state,
    type: recordingType,
    grain,
    groups: emptyGroups(),
    bounds: [...bounds],
  };
}

/** Read only fields admitted for this exact Subject type by its immutable definition release. */
export function recordingReaderVisit(input: {
  locale: string;
  public: SubjectRead;
  release?: Release;
  releaseDigest?: string;
  reason?: 'unavailable';
  bounds?: readonly ProfileBound[];
  loading?: boolean;
}): RecordingVisit {
  if (input.loading) return visitState('loading');
  if (input.reason) return visitState('unavailable');

  const release = input.release;
  if (!release || input.releaseDigest !== input.public.subject.release) return visitState('unavailable');
  const definition = release.types[recordingType];
  if (!definition) return visitState('unsupported');
  const grain = pickText(definition.labels, input.locale);
  if (input.public.subject.type !== recordingType) return visitState('invalid', grain);

  const groups = emptyGroups();
  const seen = new Set<string>();
  const relationProperties = new Set<string>();
  for (const property of definition.properties) {
    if (seen.has(property) || identityProperties.has(property)) continue;
    seen.add(property);
    const field = release.properties[property];
    if (!field) continue;
    const label = pickText(field.labels, input.locale);
    if (!label.text) continue;
    const facts = (input.public.subject.statements[property] ?? []).filter(
      (statement) => statement.property.id === property && statement.property.data_type === field.datatype,
    );
    if (!facts.length) continue;
    const group: RecordingGroup =
      field.relation?.group === 'credit'
        ? 'contributions'
        : field.relation
          ? 'associations'
          : 'details';
    groups[group].push({ property, label, definition: field, facts });
    if (field.relation) relationProperties.add(property);
  }

  const bounds = (input.bounds ?? []).filter((bound) => relationProperties.has(bound.property));
  const populated = Object.values(groups).some((fields) => fields.length > 0);
  return {
    state: populated ? 'ready' : 'empty',
    type: recordingType,
    grain,
    groups,
    bounds,
  };
}
