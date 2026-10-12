import type { Loaded, ZonePresentationRead } from './types.ts';

/** Frames use the complete published navigation, retaining the first page's
 * presentation only while every continuation names the same publication. */
export async function completePublicNavigation(
  read: (after?: string) => Promise<Loaded<ZonePresentationRead>>,
): Promise<Loaded<ZonePresentationRead>> {
  const first = await read();
  if (!first.ok) return first;
  const navigation = [...first.data.navigation];
  const cursors = new Set<string>();
  const occurrences = new Set(navigation.map(item => item.occurrence));
  if (occurrences.size !== navigation.length) return { ok: false, failure: 'unavailable' };
  let page = first.data;
  for (;;) {
    if (page.navigationComplete) {
      if (page.navigationNext !== null) return { ok: false, failure: 'unavailable' };
      return { ok: true, data: { ...first.data, navigation, navigationNext: null, navigationComplete: true } };
    }
    const after = page.navigationNext;
    if (!after || cursors.has(after)) return { ok: false, failure: 'unavailable' };
    cursors.add(after);
    const next = await read(after);
    if (!next.ok) return next;
    if (next.data.zone !== first.data.zone || next.data.revision !== first.data.revision
      || next.data.navigationRevision !== first.data.navigationRevision) return { ok: false, failure: 'moved' };
    for (const item of next.data.navigation) {
      if (occurrences.has(item.occurrence)) return { ok: false, failure: 'unavailable' };
      occurrences.add(item.occurrence);
      navigation.push(item);
    }
    page = next.data;
  }
}
