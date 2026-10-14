import { browserMainApi } from '../api/browser.ts';
import { seedTypes, type TypeRegistry } from '../catalogue/types.ts';
import { pinnedCommunities, spaceCommunities } from '../shell/communities-relationships.ts';
import { mainRelationships } from '../relationships/api.ts';
import type { RecipeAuthoringMapped as AuthoringView } from './authoring-page.ts';
import type { MainClient } from '../studio/types.ts';
import { idOf } from '../studio/types.ts';

function problemTitle(problem: unknown): string | null {
  if (typeof problem !== 'object' || problem === null) return null;
  const value = problem as { title?: unknown; detail?: unknown };
  return typeof value.title === 'string' && value.title ? value.title
    : typeof value.detail === 'string' && value.detail ? value.detail : null;
}

// The recorded visit delegates every authoring read to the production editor boundary.
export { loadRecipeAuthoring } from './authoring-page.ts';
export type RecipeAuthoringMapped = AuthoringView | { kind: 'discrepancy'; detail: string };

export type RecipeVisitFrame = { ok: true; registry: TypeRegistry } | { ok: false; detail: string };

/**
 * Root and locale layout reads for an English visit, then the shell's community lists.
 * Official Zones are a public page. The shell names the Realms on that one page of six
 * and does not ask for a later page. Account's signed-in content preferences stay on
 * LocaleLayout's `readMediaViewer`. This mapping does not issue that read and does not
 * substitute a Main answer.
 */
export async function readRecipeVisitFrame(
  main: MainClient,
  fetcher: typeof fetch,
  input: {
    actingSubject: string | null;
    /** UI locale of the visit. The recorded English visit asks agents for `en`. */
    locale: string;
    /** Origin of the replaying or host client. Official Zones are read anonymously. */
    origin: string;
  },
): Promise<RecipeVisitFrame> {
  await main.v1.me['platform-access'].get();
  const anonymous = browserMainApi(input.origin, { anonymous: true, fetcher });
  const types = await anonymous.v1.types.get();
  if (types.error || !types.data) {
    return {
      ok: false,
      detail: `GET /v1/types failed (${types.error?.status ?? 'empty'}${problemTitle(types.error?.value) ? `: ${problemTitle(types.error?.value)}` : ''})`,
    };
  }
  seedTypes(types.data);
  // The shell asks for one public page of six official Zones.
  const officialZones = { official: 'true' as const, limit: 6 };
  const zones = await anonymous.v1.zones.get({ query: officialZones });
  // A refused or empty Zone page names no Realms. The shell still continues.
  if (!zones.error && zones.data) {
    for (const zone of zones.data.items.slice(0, 6)) {
      await anonymous.v1.realms({ realm: idOf(zone.realm) }).get();
    }
  }
  const actingSubject = input.actingSubject;
  if (!actingSubject) return { ok: true, registry: types.data };
  await main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } });
  await main.v1.me.agents.get({ query: { languages: input.locale } });
  // The route requires the session header. Replay matches the path, not that header.
  await main.v1.me['session-agent'].get({ headers: { 'x-session-key': 'recorded-visit' } });
  await main.v1.agents({ id: idOf(actingSubject) }).get({ query: { actingSubject } });
  await main.v1.me['person-preferences'].get({ query: { actingSubject } });
  await main.v1.me['managed-realms'].get({ query: { actingSubject } });
  const relationships = mainRelationships(actingSubject, { fetch: fetcher });
  await pinnedCommunities(relationships, '', null).catch(() => null);
  await spaceCommunities(relationships, '', null).catch(() => null);
  await relationships.follows().catch(() => null);
  return { ok: true, registry: types.data };
}

/** Structure, expected head and acting person on a recorded file-import request. */
export function recordedFileImportTarget(
  path: string,
): { structure: string; expectedHead: string; actingSubject: string } | null {
  const url = new URL(path, 'https://recorded.invalid');
  const id = url.pathname.match(/\/v1\/recipes\/([^/]+)\/file-imports$/)?.[1];
  const expectedHead = url.searchParams.get('expectedHead');
  const actingSubject = url.searchParams.get('actingSubject');
  if (!id || !expectedHead || !actingSubject) return null;
  return { structure: `https://rezics.com/id/${id}`, expectedHead, actingSubject };
}
