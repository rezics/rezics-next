/** Existing bounded native read producers, combined for Library's optional Copy list context. */
import { readIdentityMappings } from '../identity-adapters/read.ts';
import { readListPresentationFacts } from '../copy-work-application.ts';
import { readSubjectSummaries } from '../summaries.ts';
import { activeRelease } from '../definition-release-read.ts';

export function nativeCopyListContext() {
  return {
    mappings: readIdentityMappings,
    facts: readListPresentationFacts,
    summaries: readSubjectSummaries,
    active: activeRelease,
  };
}
export type NativeCopyListContext = ReturnType<typeof nativeCopyListContext>;
