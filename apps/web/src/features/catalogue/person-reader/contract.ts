import type { SubjectRead } from '@rezics/client';
import type { PageLink } from '../../pages/shared';
import type { Reader } from '../../../subject/reader';
import type { PersonDefinitions } from './model';

export type ProfileReading = {
  public: SubjectRead;
  documents?: unknown;
  locale: string;
  release: PersonDefinitions;
  link?: PageLink;
  reader?: Reader;
};
