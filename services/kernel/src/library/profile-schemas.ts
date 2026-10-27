import { t } from 'elysia';

/** Syntax for profile supplied Library vocabulary identifiers. */
export const libraryVocabularyIdSchema = t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}(?![\\s\\S])' });

/** Stored vocabulary is returned verbatim, including values unknown to the current profile. */
export const libraryStoredVocabularySchema = t.String();
