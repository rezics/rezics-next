import { bundledDigest } from '@rezics/definitions/bundled';
import type {
  NativeIdentity,
  SourceRecord,
  SourceVocabularyBindings,
  SourceVocabularyGap,
  SourceVocabularyRequest,
  SourceVocabularyRow,
} from '@rezics/conversion';
import {
  bangumiRecordUrl,
  converter_revision as entityRevision,
  mapSourceEnumeration,
} from '@rezics/conversion/cross-media-entities';
import type { ImportConversion, SourceRegistration } from './import-contract.ts';
import { ImportTransportError, type ReviewedSubjectRead } from './import-client.ts';
import type { Importer, ImportRunResult } from './importer.ts';
import type { BangumiCharacterAppearance } from './cross-media-seed.ts';
import { bangumiAppearanceSource, combineSourceVocabularyRequests } from './cross-media-bindings.ts';
import { createSourceRegistration, crossMediaBangumiRevision, type SourceAssets } from './source-registry.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const schemes = {
  'bangumi.character.role': 'https://rezics.com/schemes/bangumi/character-kinds',
  'bangumi.subject-characters.type': 'https://rezics.com/schemes/bangumi/appearance-roles',
  'bangumi.person.career': 'https://rezics.com/schemes/bangumi/careers',
} as const;
const codes: Record<keyof typeof schemes, readonly string[]> = {
  'bangumi.character.role': ['1', '2', '3', '4'],
  'bangumi.subject-characters.type': ['1', '2', '3'],
  'bangumi.person.career': ['producer', 'mangaka', 'artist', 'seiyu', 'writer', 'illustrator', 'actor'],
};
const taxonomyGroups: Record<keyof typeof schemes, string> = {
  'bangumi.character.role': 'character.role',
  'bangumi.subject-characters.type': 'subject-characters.type',
  'bangumi.person.career': 'person.career',
};
type Taxonomy = keyof typeof schemes;

export type BangumiCharacterFidelityResult = {
  run: ImportRunResult;
  gaps: SourceVocabularyGap[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuredBindings(value: unknown): SourceVocabularyBindings {
  const raw = record(value) ? value : {};
  const releaseDigest =
    typeof raw.releaseDigest === 'string' && raw.releaseDigest.length <= 64 ? raw.releaseDigest : '';
  const schemesInput = Array.isArray(raw.schemes) ? raw.schemes.slice(0, 64) : [];
  const conceptsInput = Array.isArray(raw.concepts) ? raw.concepts.slice(0, 512) : [];
  const safeSchemes = schemesInput.flatMap((entry) => {
    if (!record(entry) || typeof entry.taxonomy !== 'string' || !Object.hasOwn(schemes, entry.taxonomy)) return [];
    const taxonomy = entry.taxonomy as Taxonomy;
    if (
      typeof entry.id !== 'string' ||
      !uuid.test(entry.id) ||
      entry.type !== 'skos:ConceptScheme' ||
      entry.uri !== schemes[taxonomy] ||
      entry.releaseDigest !== releaseDigest
    )
      return [];
    return [{ taxonomy, id: entry.id, uri: schemes[taxonomy], type: 'skos:ConceptScheme' as const, releaseDigest }];
  });
  const safeConcepts = conceptsInput.flatMap((entry) => {
    if (!record(entry) || typeof entry.taxonomy !== 'string' || !Object.hasOwn(schemes, entry.taxonomy)) return [];
    const taxonomy = entry.taxonomy as Taxonomy;
    const code = typeof entry.code === 'string' ? entry.code : '';
    if (
      !codes[taxonomy].includes(code) ||
      typeof entry.id !== 'string' ||
      !uuid.test(entry.id) ||
      typeof entry.schemeId !== 'string' ||
      !uuid.test(entry.schemeId) ||
      entry.type !== 'skos:Concept' ||
      entry.releaseDigest !== releaseDigest
    )
      return [];
    return [{ taxonomy, code, id: entry.id, type: 'skos:Concept' as const, schemeId: entry.schemeId, releaseDigest }];
  });
  return { releaseDigest, schemes: safeSchemes, concepts: safeConcepts };
}

type CurrentSubject = {
  id: string;
  type: string;
  statements: Record<string, readonly { value?: { type?: string; content?: unknown } }[]>;
};

function currentSubject(read: ReviewedSubjectRead, id: string): CurrentSubject | null {
  const subject = (read as { subject?: unknown }).subject;
  if (!record(subject) || subject.id !== id || typeof subject.type !== 'string' || !record(subject.statements))
    return null;
  return subject as CurrentSubject;
}

function hasCurrentValue(subject: CurrentSubject, property: string, content: string): boolean {
  const values = subject.statements[property];
  return (
    Array.isArray(values) &&
    values.some((statement) => statement.value?.type === 'value' && statement.value.content === content)
  );
}

async function publicSubject(
  port: { readReviewedSubject(id: string): Promise<ReviewedSubjectRead> },
  id: string,
): Promise<CurrentSubject | null> {
  try {
    const read = await port.readReviewedSubject(id);
    return currentSubject(read, id);
  } catch (error) {
    if (error instanceof ImportTransportError && error.status === 404) return null;
    throw error;
  }
}

async function nativeIdentity(
  importer: Importer,
  port: { readReviewedSubject(id: string): Promise<ReviewedSubjectRead> },
  sourceAlias: string,
  externalId: string,
  sourceId: string,
  expectedType: string,
): Promise<NativeIdentity | undefined> {
  const claim = importer.session.bindings.claim({ source: sourceAlias, external_id: externalId });
  if (claim?.state !== 'bound') return undefined;
  const subject = await publicSubject(port, claim.subject);
  if (!subject) return undefined;
  const character = externalId.startsWith('character:');
  const identifier = character ? 'wdt:P6296' : 'wdt:P5732';
  if (subject.type !== expectedType || !hasCurrentValue(subject, identifier, sourceId) || !uuid.test(subject.id))
    return undefined;
  return { id: subject.id, type: subject.type, releaseDigest: bundledDigest };
}

export async function currentBangumiCharacterVocabularyBindings(
  input: SourceVocabularyBindings,
  port: { readReviewedSubject(id: string): Promise<ReviewedSubjectRead> },
): Promise<SourceVocabularyBindings> {
  if (input.releaseDigest !== bundledDigest) return { ...input, schemes: [], concepts: [] };
  const currentSchemes = (
    await Promise.all(
      (Object.keys(schemes) as Taxonomy[]).map(async (taxonomy) => {
        const binding = input.schemes.find(
          (item) =>
            item.taxonomy === taxonomy &&
            item.uri === schemes[taxonomy] &&
            item.type === 'skos:ConceptScheme' &&
            item.releaseDigest === bundledDigest,
        );
        if (!binding) return null;
        const subject = await publicSubject(port, binding.id);
        return subject?.type === 'skos:ConceptScheme' && hasCurrentValue(subject, 'schema:url', schemes[taxonomy])
          ? binding
          : null;
      }),
    )
  ).filter((binding): binding is SourceVocabularyBindings['schemes'][number] => binding !== null);
  const schemeIds = new Map(currentSchemes.map((item) => [item.taxonomy, item.id]));
  const conceptBindings = (Object.keys(schemes) as Taxonomy[]).flatMap((taxonomy) => {
    const schemeId = schemeIds.get(taxonomy);
    return schemeId
      ? codes[taxonomy].flatMap((code) => {
          const binding = input.concepts.find(
            (item) =>
              item.taxonomy === taxonomy &&
              item.code === code &&
              item.schemeId === schemeId &&
              item.type === 'skos:Concept' &&
              item.releaseDigest === bundledDigest,
          );
          const expected = mapSourceEnumeration('bangumi', taxonomyGroups[taxonomy], code)?.concept?.id;
          return binding && expected ? [{ binding, schemeId, expected }] : [];
        })
      : [];
  });
  const currentConcepts = (
    await Promise.all(
      conceptBindings.map(async ({ binding, schemeId, expected }) => {
        const subject = await publicSubject(port, binding.id);
        return subject?.type === 'skos:Concept' &&
          hasCurrentValue(subject, 'schema:url', expected) &&
          hasCurrentValue(subject, 'skos:inScheme', schemeId)
          ? binding
          : null;
      }),
    )
  ).filter((binding): binding is SourceVocabularyBindings['concepts'][number] => binding !== null);
  return { releaseDigest: input.releaseDigest, schemes: currentSchemes, concepts: currentConcepts };
}

function sourceCode(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function rowForAppearance(
  sourceAlias: string,
  appearance: BangumiCharacterAppearance,
  work: NativeIdentity | undefined,
  character: NativeIdentity | undefined,
  roleCode: number | string,
): SourceVocabularyRow {
  const origin = bangumiAppearanceSource(sourceAlias, appearance);
  return {
    kind: 'character-appearance',
    path: `/subject-characters/${appearance.sourceIndex}/type`,
    origin: {
      externalId: origin.external_id,
      revision: origin.record_revision,
      digest: origin.digest,
      url: bangumiRecordUrl(appearance.subjectId),
      converterRevision: origin.converter_revision,
    },
    ...(work ? { subject: work } : {}),
    ...(character ? { character } : {}),
    characterCode: `character:${appearance.characterId}`,
    roleCode,
    ...(appearance.order === undefined ? {} : { order: appearance.order }),
  };
}

function uniqueGaps(gaps: readonly SourceVocabularyGap[]): SourceVocabularyGap[] {
  const found = new Map<string, SourceVocabularyGap>();
  for (const gap of gaps) found.set(JSON.stringify(gap), gap);
  return [...found.values()];
}

/** Reprojects the complete admitted Bangumi source generation through the public, current bindings. */
export async function runBangumiCharacterFidelity(input: {
  importer: Importer;
  port: { readReviewedSubject(id: string): Promise<ReviewedSubjectRead> };
  sourceAlias: string;
  records: readonly SourceRecord[];
  appearances: readonly BangumiCharacterAppearance[];
  bindings?: SourceVocabularyBindings;
}): Promise<BangumiCharacterFidelityResult> {
  const configured = configuredBindings(input.bindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] });
  const bindings = await currentBangumiCharacterVocabularyBindings(configured, input.port);
  const appearanceByWork = new Map<string, BangumiCharacterAppearance[]>();
  const characterKeys = new Set(input.appearances.map((row) => `character:${row.characterId}`));
  for (const appearance of input.appearances) {
    const rows = appearanceByWork.get(appearance.subjectId) ?? [];
    if (rows.length < 64) rows.push(appearance);
    appearanceByWork.set(appearance.subjectId, rows);
  }

  const relevant = new Set<string>();
  for (const record of input.records) {
    if (characterKeys.has(record.key)) relevant.add(record.key);
    if (appearanceByWork.has(record.key)) relevant.add(record.key);
  }
  const identities = new Map<string, NativeIdentity>();
  const recordsByKey = new Map(input.records.map((record) => [record.key, record]));
  const expectedType = (key: string): string | undefined => {
    if (key.startsWith('character:')) return 'wd:Q95074';
    const payload = recordsByKey.get(key)?.payload;
    if (payload === null || typeof payload !== 'object') return undefined;
    if ((payload as Record<string, unknown>).type === 2) return 'schema:TVSeries';
    if ((payload as Record<string, unknown>).type === 4) return 'schema:VideoGame';
    return undefined;
  };
  const jobs = [...relevant];
  for (let offset = 0; offset < jobs.length; offset += 16) {
    const page = await Promise.all(
      jobs.slice(offset, offset + 16).map(async (key) => {
        const isCharacter = key.startsWith('character:');
        const id = isCharacter ? key.slice('character:'.length) : key;
        const nativeType = expectedType(key);
        if (!nativeType) return null;
        const identity = await nativeIdentity(input.importer, input.port, input.sourceAlias, key, id, nativeType);
        return identity ? ([key, identity] as const) : null;
      }),
    );
    for (const item of page) if (item) identities.set(item[0], item[1]);
  }

  const requests = new Map<string, SourceVocabularyRequest>();
  const inputGaps: SourceVocabularyGap[] = [];
  for (const record of input.records) {
    const rows: SourceVocabularyRow[] = [];
    if (characterKeys.has(record.key) && record.payload && typeof record.payload === 'object') {
      const character = identities.get(record.key);
      const roleCode = sourceCode((record.payload as Record<string, unknown>).type);
      if (roleCode !== null)
        rows.push({
          kind: 'character-kind',
          path: `/character/${record.key.slice('character:'.length)}/type`,
          ...(character ? { character } : {}),
          code: roleCode,
        });
      else
        inputGaps.push({
          provider: 'bangumi',
          path: `/character/${record.key.slice('character:'.length)}/type`,
          endpoint: record.key,
          reason: 'invalid_row',
          property: 'schema:keywords',
        });
    }
    for (const appearance of appearanceByWork.get(record.key) ?? []) {
      const roleCode = sourceCode(appearance.roleCode);
      if (roleCode === null) {
        inputGaps.push({
          provider: 'bangumi',
          path: `/subject-characters/${appearance.sourceIndex}/type`,
          endpoint: record.key,
          reason: 'invalid_row',
          property: 'subject-characters.type',
        });
        continue;
      }
      rows.push(
        rowForAppearance(
          input.sourceAlias,
          appearance,
          identities.get(record.key),
          identities.get(`character:${appearance.characterId}`),
          roleCode,
        ),
      );
    }
    if (rows.length) requests.set(record.key, { bindings, rows });
  }

  const base = createSourceRegistration('bangumi', {
    source: input.sourceAlias,
    converterRevision: crossMediaBangumiRevision,
  });
  const gaps: SourceVocabularyGap[] = [];
  const registration: SourceRegistration<SourceAssets> = {
    ...base,
    convert(record, context): ImportConversion<SourceAssets> {
      const request = combineSourceVocabularyRequests([context.sourceVocabulary, requests.get(record.external_id)]);
      const conversion = base.convert(record, {
        ...context,
        ...(request ? { sourceVocabulary: request } : {}),
      });
      gaps.push(...(conversion.sourceVocabularyGaps ?? []));
      return conversion;
    },
  };
  const run = await input.importer.runRecords(
    registration,
    (async function* () {
      yield* input.records;
    })(),
  );
  return { run, gaps: uniqueGaps([...gaps, ...inputGaps]) };
}
