import { join } from 'node:path';

/**
 * Access admission action → graph receipt family. The sealer derives the expected receipt from this
 * family. Owner modules register new actions in their own `modules/<owner>/receipt-family.ts`
 * (exporting `receiptFamilies`), discovered here, so new command families never edit admission.ts.
 */
const base: Readonly<Record<string, string>> = {
  'work.create': 'create-metadata-work',
  'address.claim': 'work-address-claim',
  'address.rename': 'work-address-rename',
  'address.dispose': 'work-address-disposition',
  'content.draft': 'content-draft-save',
  'content.comment': 'content-comment-create',
  'content.publish': 'publish-content-revision',
  'content.search-eligibility': 'content-search-eligibility',
  'work.edit': 'edit-metadata-work',
  'work.title.apply': 'edit-metadata-work',
  'work.title.return': 'edit-metadata-work',
  'translation.link': 'translation-link-v1',
  'translation.authorize': 'translation-link-v1',
  'work.derive': 'work-derivation-v1',
  'release.seal': 'fixed-native-text-release-v1',
  'contribution.create': 'create-text-contribution',
  'contribution.edit': 'edit-text-contribution',
  'contribution.publish': 'publish-text-contribution',
  'publication.select': 'select-main-default',
  'space.create': 'create-space-realm',
  'publication.adopt': 'select-realm-local',
  'publication.reject': 'reject-realm-local',
  'publication.reject.organization': 'reject-realm-local',
  'classification.context.configure': 'classification-context-create',
  'classification.proposition.define': 'classification-proposition-create',
  'classification.decision.set': 'classification-direct-decision',
  'rating.context.create': 'rating-context-create',
  'rating.context.policy.set': 'rating-policy-set',
  'rating.observation.set': 'standing-rating-observation',
};

const registered: Record<string, string> = { ...base };
const modules = join(import.meta.dir, '..');
for (const file of [...new Bun.Glob('*/receipt-family.ts').scanSync({ cwd: modules })].sort()) {
  const module = await import(join(modules, file)) as { receiptFamilies?: Record<string, string> };
  for (const [action, family] of Object.entries(module.receiptFamilies ?? {})) {
    if (Object.hasOwn(registered, action)) throw new Error(`Duplicate receipt family for ${action} in ${file}`);
    registered[action] = family;
  }
}

export function receiptFamilyFor(action: string | undefined): string | null {
  return action !== undefined && Object.hasOwn(registered, action) ? registered[action]! : null;
}
