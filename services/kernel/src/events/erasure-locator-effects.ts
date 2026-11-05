// Shared by the effects relay (platform) and Access erasure; a leaf with no imports.
/** Owners register every effect that writes cross-partition erasure locators here. */
export const ERASURE_LOCATOR_EFFECTS: ReadonlySet<string> = new Set<string>([
  'content_author_item',
  'content_report_reporter',
  'content_party_locator',
  'content_account_upload_index',
  'community_party_locator',
  'semantic_erasure',
  'semantic_erasure_locator',
  'semantic_context_directory',
  'search_erasure',
]);
