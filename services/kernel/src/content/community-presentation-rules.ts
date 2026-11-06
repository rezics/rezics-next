import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { readExactPublishedRules } from './reads.ts';
import type { CommunityPresentation } from './community-presentation-model.ts';

export type RulesReference = Readonly<{ postId: string; revisionId: string }>;
export type PresentedRules = Extract<CommunityPresentation['rules'], { state: 'available' }>['value'];
export const rulesKey = (ref: RulesReference, realmId: string) => `${realmId}/${ref.postId}/${ref.revisionId}`;

/** No injected success proof: the existing Content native read formula owns every source check. */
export async function prepareRealmRulesSelection(
  deps: Readonly<{ pool: Pool; access: Access; clock: () => Date }>,
  actor: Actor,
  realmId: string,
  reference: RulesReference,
  context: { deadline: number },
): Promise<void> {
  const result = await readExactPublishedRules(deps, [{ ...reference, realmId }], {
    actor,
    deadline: context.deadline,
  });
  if (!result.has(rulesKey(reference, realmId)))
    throw new TypeError('Rules require a readable published Text revision in this Realm, at most 64 KiB');
}
