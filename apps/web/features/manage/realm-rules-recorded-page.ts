import type { RealmHeader } from './types.ts';

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
