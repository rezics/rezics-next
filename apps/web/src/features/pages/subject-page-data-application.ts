import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { assertSubjectPageReadActive } from './subject-page-read-lifetime';
import type { SubjectPageData } from './page-model';
import { showcaseWorkKind } from './showcase-work/model';
import type { SemanticDataPort } from './semantic-render-port';

type Subject = SubjectRead['subject'];

let dataPort: SemanticDataPort | undefined;

/** Install the loader-only catalogue capabilities at the Web composition boundary. */
export function installSemanticDataPort(port: SemanticDataPort): void {
  dataPort = port;
}

function semanticDataPort(): SemanticDataPort {
  if (!dataPort) throw new Error('Subject page Semantic data port is not installed');
  return dataPort;
}

/** The page application owns the empty, unsupported, unavailable and released outcomes for the pinned guide read. */
export async function includeReleasedWorkCatalogue(
  client: KernelClient,
  page: SubjectPageData,
  subject: Pick<Subject, 'type' | 'release'> | undefined,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<SubjectPageData> {
  if (page.catalogue || page.account || !subject || !showcaseWorkKind(subject.type)) return page;
  try {
    const release = await semanticDataPort().definitions.readGuideRelease(
      client,
      subject.release,
      authorization ? { authorization } : {},
      signal,
    );
    assertSubjectPageReadActive(signal);
    const released = Object.hasOwn(release.types, subject.type);
    return {
      ...page,
      catalogue: released
        ? {
            state: 'released',
            type: subject.type,
            digest: release.digest,
            definitions: { types: release.types, properties: release.properties },
          }
        : { state: 'unsupported', type: subject.type },
    };
  } catch (error) {
    if (!semanticDataPort().definitions.isGuideReadError(error)) throw error;
    assertSubjectPageReadActive(signal);
    return { ...page, catalogue: { state: 'unavailable', type: subject.type } };
  }
}

export type SubjectPageProfileSelection = {
  gameReader: boolean;
  gameType: boolean;
  gameGroups: Record<'credits' | 'classification' | 'relations' | 'facts', string[]>;
  releasedWorkNames: boolean;
};

/** Select only from the current subject and its current released definitions. */
export function selectSubjectPageProfiles(input: {
  type: string;
  summaryTypes?: readonly string[] | undefined;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
}): SubjectPageProfileSelection {
  const port = semanticDataPort().subjects;
  const emptyGroups: SubjectPageProfileSelection['gameGroups'] = {
    credits: [],
    classification: [],
    relations: [],
    facts: [],
  };
  const gameType = input.definitions ? port.gameType(input.definitions, input.type) : false;
  return {
    gameReader: port.gameReaderEntry(input.type, input.summaryTypes),
    gameType,
    gameGroups: gameType && input.definitions ? port.gameGroups(input.definitions, input.type) : emptyGroups,
    releasedWorkNames: port.supportsReleasedWorkNames(input.type, input.definitions),
  };
}

export function readTermsPageAuthority(
  client: KernelClient,
  viewer: 'signed-in' | 'signed-out' | 'unavailable',
  authorization?: string,
  signal?: AbortSignal,
) {
  return semanticDataPort().subjects.readTermsPageAuthority(client, viewer, authorization, signal);
}
