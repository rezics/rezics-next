import type { Pool } from 'pg';
import { createSearchGenerationPublication, type SearchGenerationPublication } from './generation-publication.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import type {
  SearchNativePublicationCompletionReader,
  SearchPublicFilterSourceBinding,
  SearchSemanticSourcePort,
} from './semantic-source-port.ts';
import type { SearchGenerationPublicationConfig } from './generation-publication.ts';

type WriterOptions = Omit<Parameters<typeof createSearchWriterGuard>[0], 'pool' | 'search'>;
export type SearchSourcePublicationInput = Omit<
  SearchGenerationPublicationConfig,
  'binding' | 'readPublicationCompletion' | 'writerGuard'
> &
  Readonly<{
    binding: SearchPublicFilterSourceBinding;
    writer: WriterOptions;
  }>;

export type SearchSourcePublicationApplication = Readonly<{
  activeRelease: SearchSemanticSourcePort['activeRelease'];
  createPublicFilterSourceBinding: SearchSemanticSourcePort['createPublicFilterSourceBinding'];
  createSubjectSourceKeyPages: SearchSemanticSourcePort['createSubjectSourceKeyPages'];
  publicFilterSource: SearchSemanticSourcePort['publicFilterSource'];
  readIdentityMappings: SearchSemanticSourcePort['readIdentityMappings'];
  readNativePublicFilterPublicationCompletion: SearchSemanticSourcePort['readNativePublicFilterPublicationCompletion'];
  readRelease: SearchSemanticSourcePort['readRelease'];
  subjectSource: SearchSemanticSourcePort['subjectSource'];
  createGenerationPublication(input: SearchSourcePublicationInput): SearchGenerationPublication;
}>;

/** Consumer-owned orchestration keeps the same binding for publication and writer admission. */
export function createSearchSourcePublicationApplication(
  port: SearchSemanticSourcePort,
): SearchSourcePublicationApplication {
  return Object.freeze({
    activeRelease: port.activeRelease,
    createPublicFilterSourceBinding: port.createPublicFilterSourceBinding,
    createSubjectSourceKeyPages: port.createSubjectSourceKeyPages,
    publicFilterSource: port.publicFilterSource,
    readIdentityMappings: port.readIdentityMappings,
    readNativePublicFilterPublicationCompletion: port.readNativePublicFilterPublicationCompletion,
    readRelease: port.readRelease,
    subjectSource: port.subjectSource,
    createGenerationPublication(input) {
      const { pool, search, binding, writer, ...generation } = input;
      const readPublicationCompletion: SearchNativePublicationCompletionReader = (request, context) =>
        port.readNativePublicFilterPublicationCompletion(binding, request, context);
      const writerGuard = createSearchWriterGuard({ pool, search, ...writer });
      return createSearchGenerationPublication({
        ...generation,
        pool,
        search,
        binding,
        readPublicationCompletion,
        writerGuard,
      });
    },
  });
}

let installed: SearchSourcePublicationApplication | undefined;

/** Composition installs the current Semantic producer explicitly; module evaluation installs nothing. */
export function bindSearchSemanticSourcePort(port: SearchSemanticSourcePort): void {
  installed = createSearchSourcePublicationApplication(port);
}

export function searchSourcePublicationApplication(): SearchSourcePublicationApplication {
  if (!installed) throw new TypeError('Search Semantic source port is not installed');
  return installed;
}
