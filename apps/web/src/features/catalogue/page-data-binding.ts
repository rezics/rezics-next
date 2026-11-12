import { DefinitionReadError, fetchGuideRelease } from './definition-guide';
import { supportsReleasedWorkNames } from './work-names/model';
import { gameGroups, gameType } from './game-profile';
import { gameReaderEntry } from './game-reader/model';
import { readTermsPageAuthority } from './subject-terms-request';
import type { SemanticDataPort } from '../pages/semantic-render-port';

/** Native and definition reads used by route loaders, without loading page components. */
export const pageDataBinding: SemanticDataPort = {
  definitions: {
    readGuideRelease: fetchGuideRelease,
    isGuideReadError: (error) => error instanceof DefinitionReadError,
  },
  subjects: {
    supportsReleasedWorkNames,
    gameReaderEntry,
    gameGroups,
    gameType,
    readTermsPageAuthority,
  },
};
