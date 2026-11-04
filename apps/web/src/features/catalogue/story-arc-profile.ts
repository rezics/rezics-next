import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { EditorRead } from './statement-editor';
import type { CreateTransport } from './create-subject';
import type { RelationRead } from '../../subject/relation-candidates';

export const storyArcType = 'wd:Q2620972';
export const storyArcProperty = 'rezics:storyArc';
export const storyArcUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type StoryArcAddress = { id?: string | undefined; work?: string | undefined };
/** Public admission evidence. Creation permission is CreateTransport.eligibility, not this read. */
export type StoryArcRead =
  | { ok: false; reason: 'invalid' | 'denied' | 'stale' | 'unavailable' }
  | { ok: true; release: Release; arc: SubjectRead | null; work: SubjectRead | null };
export type StoryArcTransport = {
  load: (address: StoryArcAddress) => Promise<StoryArcRead>;
  /** Creation consumes the shared parent subject.create observation. */
  creation: CreateTransport;
};

/** The effective release alone admits a work's forward arc relation and its native qualifiers. */
export function storyArcWork(release: Release, type: string): boolean {
  const property = release.properties[storyArcProperty];
  return !!(
    release.types[type]?.properties.includes(storyArcProperty) &&
    property?.datatype === 'wikibase-item' &&
    property.relation &&
    property.targets?.includes(storyArcType)
  );
}

export function storyArcRelations(read: RelationRead, release: Release, work = false): RelationRead {
  if (!read.ok) return read;
  if (work ? !storyArcWork(release, read.public.subject.type) : read.public.subject.type !== storyArcType)
    return { ok: false, reason: 'invalid' };
  const admitted = release.types[read.public.subject.type]?.properties ?? [];
  return {
    ...read,
    fields: read.fields.filter((field) => admitted.includes(field.id) && (!work || field.id === storyArcProperty)),
  };
}

export function storyArcFacts(read: Extract<StoryArcRead, { ok: true }>): EditorRead {
  return read.arc
    ? { ok: true, release: read.release, public: read.arc, source: null }
    : { ok: false, reason: 'invalid' };
}

/** Independent public reads; no inferred parent, redirect substitution or per-row hydration. */
export async function readStoryArcProfile(client: KernelClient, address: StoryArcAddress): Promise<StoryArcRead> {
  if ([address.id, address.work].some((id) => id !== undefined && !storyArcUuid.test(id)))
    return { ok: false, reason: 'invalid' };
  try {
    const [active, arc, work] = await Promise.all([
      client.definitions.active.get(),
      address.id ? client.subjects({ id: address.id }).get({ fetch: { redirect: 'manual' } }) : undefined,
      address.work ? client.subjects({ id: address.work }).get({ fetch: { redirect: 'manual' } }) : undefined,
    ]);
    for (const [result, id] of [
      [arc, address.id],
      [work, address.work],
    ] as const) {
      if (!id) continue;
      if (result?.status === 403 || result?.status === 404) return { ok: false, reason: 'denied' };
      if (result?.status === 308 || (result?.data && result.data.subject.id !== id))
        return { ok: false, reason: 'stale' };
      if (result?.status !== 200 || !result.data) return { ok: false, reason: 'unavailable' };
    }
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types?.[storyArcType] || !release.properties) return { ok: false, reason: 'unavailable' };
    if (
      (arc?.data && arc.data.subject.type !== storyArcType) ||
      (work?.data && !storyArcWork(release, work.data.subject.type))
    )
      return { ok: false, reason: 'invalid' };
    return { ok: true, release, arc: arc?.data ?? null, work: work?.data ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
