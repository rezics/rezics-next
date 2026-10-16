import { isDeepStrictEqual } from 'node:util';
import { importRecipe } from './importer.ts';
import { GUTENBERG_LICENSE } from '../rights/import-policy.ts';
import { PublicationUnavailable } from '../contribution/publish.ts';
import { readSourceCorrespondenceRecords, type SourceCorrespondenceVerifier } from '../structure/source-correspondence.ts';

/** Schema.org Recipe interpretation belongs to the profile, never Work publication. */
export const verifyRecipeSource: SourceCorrespondenceVerifier = async ({ environment, observation, header }) => {
  const refuse = (reason = 'source-incomplete') => new PublicationUnavailable(`Recipe source correspondence is unavailable: ${reason}`);
  if (observation.coverage.scope !== 'complete-recipe'
    || !/^application\/(?:json|ld\+json)(?:;|$)/i.test(observation.mediaType)) throw refuse('source-evidence');
  let document: { url?: unknown; author?: { name?: unknown }; license?: unknown };
  try { document = JSON.parse(Buffer.from(observation.rawBytesBase64!, 'base64').toString('utf8')); }
  catch { throw refuse(); }
  const url = typeof document.url === 'string' ? document.url : '';
  if (!/^https?:\/\//.test(url) || typeof document.author?.name !== 'string'
    || !document.author.name || document.author.name.length > 200) throw refuse();
  const parsed = importRecipe(document, observation.observation);
  const expected = new Map<string, { role: string; parent: string | null; text?: unknown; labels?: unknown }>([
    ...parsed.ingredients.map(item => [item.sourceKey, { role: 'ingredient', parent: null,
      text: { ...item.qualifier, ...(item.qualifier.parseStatus !== 'parsed'
        ? { residual: `sha256:${parsed.residual}` } : {}) } }] as const),
    ...parsed.steps.map(item => [item.sourceKey, { role: 'step', parent: parsed.sections[item.section]?.sourceKey ?? null,
      text: { value: item.text, language: item.language } }] as const),
    ...parsed.sections.map(item => [item.sourceKey, { role: 'group', parent: parsed.sections[item.parent]?.sourceKey ?? null,
      labels: [{ value: item.label, language: item.language }] }] as const),
  ]);
  if (header.profile !== 'recipe-composition' || header.placementCount !== expected.size || !expected.size)
    throw refuse('structure-source');
  const records = await readSourceCorrespondenceRecords(environment, header, expected.size);
  if (!isDeepStrictEqual(records.filter(item => item.role === 'ingredient').map(item => item.sourceKey),
    parsed.ingredients.map(item => item.sourceKey))
    || !isDeepStrictEqual(records.filter(item => item.role === 'step').map(item => item.sourceKey),
      parsed.steps.map(item => item.sourceKey))
    || !isDeepStrictEqual(records.filter(item => item.role === 'group').map(item => item.sourceKey),
      parsed.sections.map(item => item.sourceKey))) throw refuse('source-order');
  const keys = new Map(records.map(record => [record.occurrence, record.sourceKey]));
  if (records.length !== expected.size || new Set(records.map(record => record.sourceKey)).size !== expected.size)
    throw refuse();
  for (const record of records) {
    const wanted = record.sourceKey ? expected.get(record.sourceKey) : undefined;
    const qualifier = record.qualifier;
    if (!wanted || record.role !== wanted.role || record.target && record.target !== record.occurrence
      || (record.parent === header.structure ? null : keys.get(record.parent)) !== wanted.parent
      || wanted.role === 'ingredient' && !isDeepStrictEqual(qualifier, wanted.text)
      || wanted.role === 'step' && (!qualifier || qualifier.type !== 'recipe-step'
        || qualifier.media.length > 0 || qualifier.usesIngredient.length > 0
        || !isDeepStrictEqual(qualifier.instructionText, wanted.text))
      || wanted.role === 'group' && !isDeepStrictEqual(record.labels, wanted.labels)) {
      throw refuse('source-text');
    }
  }
  return { observation: observation.observation, structure: header.structure, revision: header.head,
    attribution: { url, author: document.author.name,
      license: observation.provider === 'gutenberg' || observation.provider === 'project-gutenberg'
        ? GUTENBERG_LICENSE : typeof document.license === 'string' && /^https?:\/\//.test(document.license)
          ? document.license : null } };
};
