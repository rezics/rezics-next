import {
  createPublicFilterSourceBinding,
  createSubjectSourceKeyPages,
  publicFilterSource,
  readNativePublicFilterPublicationCompletion,
} from '../semantic/index.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { subjectSource } from '../semantic/search-source.ts';
import { bindSearchSemanticSourcePort, type SearchSemanticSourcePort } from '../search/composition.ts';

/** Bind Semantic's existing public producers to Search's consumer-owned source port. */
export function composeSearchSemanticSource(): void {
  const port: SearchSemanticSourcePort = Object.freeze({
    activeRelease,
    createPublicFilterSourceBinding,
    createSubjectSourceKeyPages,
    publicFilterSource,
    readIdentityMappings,
    readNativePublicFilterPublicationCompletion,
    readRelease,
    subjectSource,
  });
  bindSearchSemanticSourcePort(port);
}

