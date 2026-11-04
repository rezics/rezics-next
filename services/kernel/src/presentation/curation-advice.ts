import type { PresentationProfile } from '@rezics/composition';

export type CurationViewer = 'anonymous' | 'account';
export type CurationActionState = 'allowed' | 'denied' | 'unavailable';
export type CurationActionAdvice = {
  publish: CurationActionState;
  activate: CurationActionState;
};

export type CurationOpening =
  | { state: 'missing' }
  | {
      state: 'active';
      viewer: CurationViewer;
      digest: string;
      head: number;
      profile: PresentationProfile;
      advice: CurationActionAdvice;
    };

type Active = { digest: string; head: number };

const unavailable = (): CurationActionAdvice => ({ publish: 'unavailable', activate: 'unavailable' });
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only a complete, exact Global Context viewer-actions row can give a denial. */
export function curationAdviceFromViewerActions(value: unknown): CurationActionAdvice {
  if (!record(value) || !closed(value, ['resources']) || !Array.isArray(value.resources) || value.resources.length !== 1)
    return unavailable();
  const resource = value.resources[0];
  if (
    !record(resource) ||
    resource.type !== 'semantic.context' ||
    resource.id !== '00000000-0000-8000-8000-000000000000' ||
    !closed(resource, ['type', 'id', 'viewerActions']) ||
    !Array.isArray(resource.viewerActions)
  )
    return unavailable();

  const actions = new Map<string, string[]>();
  for (const entry of resource.viewerActions) {
    if (
      !record(entry) ||
      !closed(entry, ['action', 'operations']) ||
      typeof entry.action !== 'string' ||
      !Array.isArray(entry.operations) ||
      entry.operations.some((operation) => typeof operation !== 'string') ||
      new Set(entry.operations).size !== entry.operations.length ||
      actions.has(entry.action)
    )
      return unavailable();
    actions.set(entry.action, entry.operations as string[]);
  }

  return {
    publish: actions.get('presentation:publish')?.includes('presentation.publish') ? 'allowed' : 'denied',
    activate: actions.get('presentation:activate')?.includes('presentation.activate') ? 'allowed' : 'denied',
  };
}

/**
 * Assemble one bounded opening from point reads and current viewer-action advice.
 * An advice dependency failure leaves the readable composition available with both controls unavailable.
 */
export async function readCurationOpening(input: {
  viewer: CurationViewer;
  readActive: () => Promise<Active | null>;
  readProfile: (digest: string) => Promise<PresentationProfile | null>;
  readViewerActions: () => Promise<unknown>;
}): Promise<CurationOpening | { state: 'stale' }> {
  const active = await input.readActive();
  if (!active) return { state: 'missing' };
  let initialAdvice = unavailable();
  let initialAvailable = true;
  try {
    initialAdvice = curationAdviceFromViewerActions(await input.readViewerActions());
    initialAvailable = initialAdvice.publish !== 'unavailable' || initialAdvice.activate !== 'unavailable';
  } catch {
    initialAvailable = false;
  }

  const profile = await input.readProfile(active.digest);
  if (!profile) throw new Error('The active profile body is unavailable');

  let advice = unavailable();
  try {
    const latestAdvice = curationAdviceFromViewerActions(await input.readViewerActions());
    if (initialAvailable) {
      advice = {
        publish: initialAdvice.publish === latestAdvice.publish ? latestAdvice.publish : 'unavailable',
        activate: initialAdvice.activate === latestAdvice.activate ? latestAdvice.activate : 'unavailable',
      };
    }
  } catch {
    // Action advice is optional to reading the public composition.
  }

  const current = await input.readActive();
  if (!current || current.digest !== active.digest || current.head !== active.head) return { state: 'stale' };
  return { state: 'active', viewer: input.viewer, ...active, profile, advice };
}
