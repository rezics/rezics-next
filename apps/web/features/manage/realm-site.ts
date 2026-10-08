import { zoneEditorPath } from '../zone-editor/routes.ts';
import { isUuid, type Loaded, uuidOf } from './types.ts';

/** The Zone a Realm frame needs before it can offer its editor. */
export interface RealmZoneRef { zone: string; routeSegment: string | null }

/**
 * The editor address for one Realm, or null when it has no Zone or the agent
 * may not edit that Zone. The editor read runs only after the Zone read succeeds.
 */
export async function realmEditSite(read: {
  zone: () => Promise<Loaded<RealmZoneRef>>;
  editor: (zoneId: string) => Promise<Loaded<unknown>>;
}): Promise<string | null> {
  const zone = await read.zone();
  if (!zone.ok) return null;
  const id = uuidOf(zone.data.zone);
  if (!isUuid(id)) return null;
  const allowed = await read.editor(id);
  if (!allowed.ok) return null;
  const segment = zone.data.routeSegment;
  return zoneEditorPath(segment && !isUuid(segment) ? segment : id);
}
