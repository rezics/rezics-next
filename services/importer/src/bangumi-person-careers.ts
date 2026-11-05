import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings, SourceVocabularyRow } from '@rezics/conversion';
import { currentBangumiCharacterVocabularyBindings } from './bangumi-character-fidelity.ts';
import type { ReviewedSubjectRead } from './import-client.ts';
import type { ImporterOptions } from './importer.ts';

const taxonomy = 'bangumi.person.career';
const schemeUri = 'https://rezics.com/schemes/bangumi/careers';
const careers = ['producer', 'mangaka', 'artist', 'seiyu', 'writer', 'illustrator', 'actor'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A bounded external file supplies lookup hints, never authority or accepted vocabulary. */
export function parseBangumiPersonCareerBindings(value: unknown): SourceVocabularyBindings {
  const input = value as { schemeId?: unknown; schemeUri?: unknown; concepts?: unknown } | null;
  if (!input || typeof input.schemeId !== 'string' || !uuid.test(input.schemeId) || input.schemeUri !== schemeUri)
    throw new TypeError('Invalid Bangumi Person career Scheme binding');
  if (!Array.isArray(input.concepts) || input.concepts.length > careers.length)
    throw new TypeError('Bangumi Person career bindings exceed their concept cap');
  const seenCodes = new Set<string>();
  const seenIds = new Set<string>([input.schemeId]);
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const value of input.concepts) {
    const row = value as { code?: unknown; id?: unknown } | null;
    if (
      !row ||
      typeof row.code !== 'string' ||
      !careers.includes(row.code) ||
      typeof row.id !== 'string' ||
      !uuid.test(row.id) ||
      seenCodes.has(row.code) ||
      seenIds.has(row.id)
    )
      throw new TypeError('Invalid or duplicate Bangumi Person career Concept binding');
    seenCodes.add(row.code);
    seenIds.add(row.id);
    concepts.push({
      taxonomy,
      code: row.code,
      id: row.id,
      schemeId: input.schemeId,
      type: 'skos:Concept',
      releaseDigest: bundledDigest,
    });
  }
  return {
    releaseDigest: bundledDigest,
    schemes: [
      { taxonomy, id: input.schemeId, uri: schemeUri, type: 'skos:ConceptScheme', releaseDigest: bundledDigest },
    ],
    concepts,
  };
}

/** Re-read current native vocabulary for each record, including an unchanged source refresh. */
export function createBangumiPersonCareerAdmission(
  profile: SourceVocabularyBindings,
  port: { readReviewedSubject(id: string, signal?: AbortSignal): Promise<ReviewedSubjectRead> },
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    async resolve({ owner, conversion, subject, signal }) {
      if (!owner.external_id.startsWith('person:') || !subject) return undefined;
      const normalized = conversion.normalized as { type: number; career?: (string | null)[] | null };
      if (normalized.type !== 1 || !Array.isArray(normalized.career)) return undefined;
      const codes = normalized.career.filter((code): code is string => code !== null);
      const bindings = await currentBangumiCharacterVocabularyBindings(
        { ...profile, concepts: profile.concepts.filter((concept) => codes.includes(concept.code)) },
        { readReviewedSubject: (id) => port.readReviewedSubject(id, signal) },
      );
      const rows: SourceVocabularyRow[] = codes.map((code) => ({
        kind: 'person-career',
        code,
        path: '/career',
        person: { id: subject, type: 'schema:Person', releaseDigest: bundledDigest },
      }));
      return { bindings, rows };
    },
  };
}
