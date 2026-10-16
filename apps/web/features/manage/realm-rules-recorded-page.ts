import { readSettings } from './read.ts';
import { readManagementAccess } from './settings-api.ts';
import { uuidOf, type MainClient, type RealmHeader } from './types.ts';

/** The settings route admits access before reading the rules and their CAS basis. */
export async function readRealmRulesSettings(main: MainClient, realm: string, actingSubject: string) {
  const access = await readManagementAccess(main, realm, actingSubject);
  if (!access.ok) return { kind: 'access-failure' as const, result: access };
  const capability = uuidOf(access.data.realm);
  const settings = await readSettings(main, capability, actingSubject);
  if (!settings.ok) return { kind: 'settings-failure' as const, result: settings };
  return { kind: 'settings' as const, capability, access: access.data, settings: settings.data };
}

/**
 * Rules as the public rules page lists them. The route and a recorded story
 * both use this mapping, so a story cannot show a rule the header did not publish.
 */
export interface PublishedRealmRule {
  id: string;
  title: string;
  body: string;
  governed: boolean;
  lang: string;
}

/** Null when the header has not published any rules. */
export function publishedRealmRules(rules: RealmHeader['rules']): PublishedRealmRule[] | null {
  if (!rules) return null;
  return rules.map(rule => ({
    id: rule.id,
    title: rule.title.value,
    body: rule.body.value,
    governed: rule.governanceRule !== null,
    lang: rule.title.language,
  }));
}
