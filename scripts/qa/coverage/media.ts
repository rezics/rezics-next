import type { CaseDeclarations } from './declaration.ts';

export const mediaCases: CaseDeclarations = {
  VIEW07: [
    { tier: 'integration', file: 'tests/qa/integration/resource-summary.test.ts',
      name: 'VIEW07: private, revoked and erased content/media leak no preview, sitemap entry or delivery' },
    { tier: 'integration', file: 'tests/qa/integration/resource-summary.test.ts',
      name: 'VIEW07: erasing a published Content revision suppresses public metadata and media delivery' },
    { tier: 'unit', file: 'apps/web/tests/seo.test.ts',
      name: 'VIEW07: a restricted Work gives no description, preview or index entry, even to a reader who may see it' },
    { tier: 'e2e', file: 'apps/web/tests/seo.e2e.ts',
      name: 'VIEW07: a private Work its reader may see keeps its title for them and gives search nothing' },
  ],
  VIEW08: [
    { tier: 'integration', file: 'tests/qa/integration/resource-summary.test.ts',
      name: 'VIEW08: Main Version language selection, fallback, RTL direction and metadata-only emptiness are explicit' },
    { tier: 'integration', file: 'tests/qa/integration/resource-summary.test.ts',
      name: 'VIEW08: batched summaries hydrate names and avatars with fixed owner round trips, contexts and partial results' },
    { tier: 'integration', file: 'tests/qa/integration/resource-summary.test.ts',
      name: 'VIEW08: Character, Context, Realm, Role and RelationDefinition summaries obey owner reads' },
  ],
  BOOK09: [
    { tier: 'integration', file: 'tests/qa/integration/media-publication.test.ts',
      name: 'BOOK09: an image-only publication activates exact RustFS images without a fabricated text document' },
    { tier: 'integration', file: 'tests/qa/integration/media-publication.test.ts',
      name: 'BOOK09: a poll-only publication uses the poll owner without creating a text document' },
  ],
};
