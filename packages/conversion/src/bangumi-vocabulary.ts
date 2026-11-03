import {
  createMappingEnvironment,
  finishMapping,
  type BangumiVocabularyRow,
  type MappingEnvironment,
  type NativeIdentity,
  type ResolvedConcept,
  type SourceVocabularyInput,
  type SourceVocabularyResult,
} from './source-vocabulary.ts';

export const bangumiVocabularyRevision = 'bangumi-vocabulary@1';
const episodeScheme = 'https://rezics.com/schemes/bangumi/episode-types';
const characterScheme = 'https://rezics.com/schemes/bangumi/character-kinds';
const appearanceScheme = 'https://rezics.com/schemes/bangumi/appearance-roles';
const episodeCodes = new Set(['0', '1', '2', '3', '4', '5', '6']);
const characterCodes = new Set(['1', '2', '3', '4']);
const appearanceCodes = new Set(['1', '2', '3']);

// Exact property terms grouped by the pinned Archive staff enumeration. A role code is never an order.
const staffTerms: Readonly<Record<1 | 2 | 4, Readonly<Record<string, readonly number[]>>>> = {
  1: {
    'schema:author': [2001, 2010],
    'schema:illustrator': [2002, 2003],
    'schema:publisher': [2004],
    'schema:contributor': [2005, 2007, 2008, 2009, 2011, 2012, 2013, 2015, 2016, 2017],
    'schema:translator': [2006],
    'schema:editor': [2014],
  },
  2: {
    'schema:author': [1, 3],
    'schema:director': [2, 41, 49, 74],
    'schema:contributor': [
      4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27, 29, 30, 33, 34, 35, 37, 38, 39, 40, 43,
      44, 45, 46, 47, 48, 50, 53, 55, 56, 57, 61, 62, 64, 65, 66, 69, 70, 71, 72, 73, 75, 76, 77, 81, 82, 83, 84, 86,
      88, 89, 90, 91, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113,
      114, 115, 116, 117, 120, 123, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143,
      144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173,
      174, 175, 176, 177, 178, 180, 181,
    ],
    'schema:musicBy': [6, 31, 119],
    'wdt:P6942': [20, 21, 51, 92, 157],
    'schema:editor': [28, 60, 155, 156],
    'schema:lyricist': [32, 118],
    'schema:producer': [36, 52, 54, 58, 59, 80, 85, 87, 121, 122, 124, 125, 158, 159, 160, 161, 182],
    'schema:productionCompany': [42, 63, 67, 179],
  },
  4: {
    'wdt:P178': [1001],
    'schema:publisher': [1002],
    'wdt:P287': [1003],
    'schema:author': [1004, 1020],
    'schema:contributor': [
      1005, 1007, 1008, 1011, 1012, 1013, 1015, 1017, 1018, 1019, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029,
      1030, 1031, 1033, 1034, 1035,
    ],
    'schema:musicBy': [1006, 1009],
    'schema:lyricist': [1010],
    'schema:productionCompany': [1014],
    'schema:director': [1016],
    'schema:producer': [1032],
  },
};
const relationTerms: Readonly<Record<1 | 2 | 4, Readonly<Record<number, { property: string; inverse?: true }>>>> = {
  1: {
    1: { property: 'rezics:crossMediaCounterpart' },
    1002: { property: 'wdt:P179' },
    1004: { property: 'rezics:artbookCounterpart' },
    1005: { property: 'wdt:P155' },
    1006: { property: 'wdt:P155', inverse: true },
    1007: { property: 'rezics:sideStoryOf', inverse: true },
    1008: { property: 'wdt:P361' },
    1010: { property: 'rezics:editionCounterpart' },
    1011: { property: 'rezics:sameCharacters' },
    1012: { property: 'rezics:sameSetting' },
    1013: { property: 'rezics:alternativeSetting' },
    1014: { property: 'rezics:collaborationWith' },
    1015: { property: 'rezics:alternativeVersion' },
    1099: { property: 'rezics:bangumiRelatedTo' },
  },
  2: {
    1: { property: 'rezics:crossMediaCounterpart' },
    2: { property: 'wdt:P155' },
    3: { property: 'wdt:P155', inverse: true },
    4: { property: 'rezics:summaryOf', inverse: true },
    5: { property: 'rezics:summaryOf' },
    6: { property: 'rezics:sideStoryOf', inverse: true },
    7: { property: 'rezics:sameCharacters' },
    8: { property: 'rezics:sameSetting' },
    9: { property: 'rezics:alternativeSetting' },
    10: { property: 'rezics:alternativeVersion' },
    11: { property: 'rezics:spinOffOf', inverse: true },
    12: { property: 'wdt:P361' },
    14: { property: 'rezics:collaborationWith' },
    99: { property: 'rezics:bangumiRelatedTo' },
  },
  4: {
    1: { property: 'rezics:crossMediaCounterpart' },
    4002: { property: 'wdt:P155' },
    4003: { property: 'wdt:P155', inverse: true },
    4006: { property: 'rezics:sideStoryOf', inverse: true },
    4007: { property: 'rezics:sameCharacters' },
    4008: { property: 'rezics:sameSetting' },
    4009: { property: 'rezics:alternativeSetting' },
    4010: { property: 'rezics:alternativeVersion' },
    4012: { property: 'wdt:P361' },
    4013: { property: 'rezics:bangumiLegacyVersion' },
    4014: { property: 'rezics:collaborationWith' },
    4015: { property: 'rezics:expansionCounterpart' },
    4016: { property: 'schema:exampleOfWork', inverse: true },
    4017: { property: 'schema:exampleOfWork' },
    4018: { property: 'wdt:P361' },
    4019: { property: 'wdt:P361', inverse: true },
    4099: { property: 'rezics:bangumiRelatedTo' },
  },
};
const reverseSpecific: Readonly<Record<number, string>> = {
  6: 'rezics:sideStoryOf',
  11: 'rezics:spinOffOf',
  1007: 'rezics:sideStoryOf',
  4006: 'rezics:sideStoryOf',
};

function conceptIdentity(value: ResolvedConcept): NativeIdentity {
  return { id: value.id, type: value.type, releaseDigest: value.releaseDigest };
}
function exactConcept(
  environment: MappingEnvironment,
  taxonomy: string,
  code: string,
  path: string,
  expectedScheme?: string,
): ResolvedConcept | null {
  if (expectedScheme) {
    const scheme = environment.input.bindings.schemes.find((item) => item.taxonomy === taxonomy);
    if (scheme && scheme.uri !== expectedScheme) {
      environment.pushGap({ path, code, reason: 'missing_scheme', property: expectedScheme });
      return null;
    }
  }
  return environment.concept(taxonomy, code, path);
}
function relationIdentityKey(subjectId: string, property: string, targetId: string): string {
  return `${subjectId}\u0000${property}\u0000${targetId}`;
}

function mapRow(environment: MappingEnvironment, row: BangumiVocabularyRow, seenRelations: Set<string>): void {
  const path = environment.sourcePath(row.path);
  if (!path) {
    environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
    return;
  }
  switch (row.kind) {
    case 'episode-sort': {
      const sort = typeof row.sort === 'number' && Number.isFinite(row.sort) ? String(row.sort) : row.sort;
      if (typeof sort !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(sort)) {
        environment.pushGap({ path, reason: 'invalid_source_value', property: 'schema:episodeNumber' });
        return;
      }
      environment.propose({
        row,
        subject: row.episode,
        property: 'schema:episodeNumber',
        content: sort,
        mappingRevision: 'episode-sort@1',
      });
      return;
    }
    case 'episode-kind': {
      const code = environment.sourceCode(row.code);
      if (!code || !episodeCodes.has(code)) {
        environment.pushGap({ path, ...(code ? { code } : {}), reason: 'unknown_code', property: 'episode.type' });
        return;
      }
      const resolved = exactConcept(environment, 'bangumi.episode.type', code, path, episodeScheme);
      if (resolved)
        environment.propose({
          row,
          subject: row.episode,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: bangumiVocabularyRevision,
        });
      return;
    }
    case 'character-kind': {
      const code = environment.sourceCode(row.code);
      if (!code || !characterCodes.has(code)) {
        environment.pushGap({ path, ...(code ? { code } : {}), reason: 'unknown_code', property: 'character.role' });
        return;
      }
      const resolved = exactConcept(environment, 'bangumi.character.role', code, path, characterScheme);
      if (resolved)
        environment.propose({
          row,
          subject: row.character,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: bangumiVocabularyRevision,
        });
      return;
    }
    case 'staff': {
      const table =
        row.subjectType === 1 || row.subjectType === 2 || row.subjectType === 4
          ? staffTerms[row.subjectType]
          : undefined;
      const property = table && Object.entries(table).find(([, codes]) => codes.includes(row.roleCode))?.[0];
      const code = environment.sourceCode(row.roleCode);
      if (!code || !property) {
        environment.pushGap({
          path,
          ...(code ? { code } : {}),
          reason: 'unknown_code',
          property: `staff.${row.subjectType}`,
        });
        return;
      }
      if (!row.holder) {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.holderCode) ?? undefined,
          reason: 'missing_identity',
          property,
        });
        return;
      }
      const resolved = exactConcept(environment, 'bangumi.staff', code, path);
      if (!resolved) return;
      const qualifiers: { property: string; content: unknown; identity?: NativeIdentity }[] = [
        { property: 'wdt:P3831', content: resolved.id, identity: conceptIdentity(resolved) },
      ];
      if (row.creditedAs !== undefined) {
        if (
          typeof row.creditedAs !== 'string' ||
          !row.creditedAs.isWellFormed() ||
          !row.creditedAs.trim() ||
          row.creditedAs.length > 1500
        ) {
          environment.pushGap({ path, code, reason: 'invalid_source_value', property: 'wdt:P1932' });
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      if (row.order !== undefined) {
        if (!Number.isSafeInteger(row.order) || row.order < 0) {
          environment.pushGap({ path, code, reason: 'invalid_source_value', property: 'schema:position' });
          return;
        }
        qualifiers.push({ property: 'schema:position', content: String(row.order + 1) });
      }
      environment.propose({
        row,
        subject: row.subject,
        property,
        content: '',
        target: row.holder,
        sourceEndpoint: row.holderCode,
        qualifiers,
        mappingRevision: `staff-${row.subjectType}@1`,
      });
      return;
    }
    case 'character-appearance': {
      const code = environment.sourceCode(row.roleCode);
      if (!code || !appearanceCodes.has(code)) {
        environment.pushGap({
          path,
          ...(code ? { code } : {}),
          reason: 'unknown_code',
          property: 'subject-characters.type',
        });
        return;
      }
      const role = exactConcept(environment, 'bangumi.subject-characters.type', code, path, appearanceScheme);
      if (!row.character) {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.characterCode) ?? undefined,
          reason: 'missing_identity',
          property: 'schema:character',
        });
        return;
      }
      if (role)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:character',
          content: '',
          target: row.character,
          sourceEndpoint: row.characterCode,
          qualifiers: [{ property: 'wdt:P3831', content: role.id, identity: conceptIdentity(role) }],
          mappingRevision: 'appearance-role@1',
        });
      return;
    }
    case 'voice-credit': {
      const performer = row.performer;
      if (!performer) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.performerCode) ?? undefined,
          reason: 'missing_identity',
          property: 'wdt:P725',
        });
        return;
      }
      const performerId = environment.identityId(performer);
      if (!performerId) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.performerCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P725',
        });
        return;
      }
      const character = row.character;
      if (!character) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.characterCode) ?? undefined,
          reason: 'missing_identity',
          property: 'wdt:P453',
        });
        return;
      }
      const characterId = environment.identityId(character);
      if (!characterId) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.characterCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P453',
        });
        return;
      }
      const qualifiers: { property: string; content: unknown; identity?: NativeIdentity }[] = [
        { property: 'wdt:P453', content: characterId, identity: character },
      ];
      if (row.creditedAs !== undefined) {
        if (
          typeof row.creditedAs !== 'string' ||
          !row.creditedAs.isWellFormed() ||
          !row.creditedAs.trim() ||
          row.creditedAs.length > 1500
        ) {
          environment.pushGap({ path, reason: 'invalid_source_value', property: 'wdt:P1932' });
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      environment.propose({
        row,
        subject: row.subject,
        property: 'wdt:P725',
        content: '',
        target: performer,
        sourceEndpoint: row.performerCode,
        qualifiers,
        mappingRevision: 'voice-credit@1',
      });
      return;
    }
    case 'relation': {
      const code = environment.sourceCode(row.code);
      const family = row.family === 1 || row.family === 2 || row.family === 4 ? row.family : undefined;
      const numberCode = typeof row.code === 'number' && Number.isSafeInteger(row.code) ? row.code : undefined;
      const mapped = family === undefined || numberCode === undefined ? undefined : relationTerms[family][numberCode];
      if (!code || !mapped) {
        environment.pushGap({
          path,
          ...(code ? { code } : {}),
          reason: 'unknown_code',
          property: `relation.${row.family}`,
        });
        return;
      }
      if (!row.endpoint) {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.endpointCode) ?? undefined,
          reason: 'missing_identity',
          property: mapped.property,
        });
        return;
      }
      let subject = mapped.inverse ? row.endpoint : row.subject;
      let endpoint = mapped.inverse ? row.subject : row.endpoint;
      const subjectId = environment.identityId(subject);
      const endpointId = environment.identityId(endpoint);
      if (!endpointId) {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.endpointCode) ?? undefined,
          reason: row.endpoint ? 'incompatible_identity' : 'missing_identity',
          property: mapped.property,
        });
        return;
      }
      if (!subjectId) {
        environment.pushGap({ path, code, reason: 'incompatible_identity', property: mapped.property });
        return;
      }
      let property = mapped.property;
      if (
        (row.code === 12 || row.code === 1008 || row.code === 4012) &&
        typeof row.reciprocalCode === 'number' &&
        Number.isSafeInteger(row.reciprocalCode)
      ) {
        const canonical = reverseSpecific[row.reciprocalCode];
        if (canonical) property = canonical;
      }
      const definition = environment.release.properties[property];
      if (!environment.admit(subject, property, path, code)) return;
      let canonicalSubjectId = subjectId;
      let canonicalEndpointId = endpointId;
      if (definition?.relation?.symmetric && canonicalEndpointId < canonicalSubjectId) {
        [subject, endpoint] = [endpoint, subject];
        [canonicalSubjectId, canonicalEndpointId] = [canonicalEndpointId, canonicalSubjectId];
      }
      const canonicalKey = relationIdentityKey(canonicalSubjectId, property, canonicalEndpointId);
      if (seenRelations.has(canonicalKey)) return;
      seenRelations.add(canonicalKey);
      environment.propose({
        row,
        subject,
        property,
        content: '',
        target: endpoint,
        sourceEndpoint: row.endpointCode,
        mappingRevision: `relation-${row.family}@1`,
      });
      return;
    }
  }
}

/** Maps only caller-traversed archive rows; it never collects or follows source graph edges. */
export function mapBangumiVocabulary(input: SourceVocabularyInput): SourceVocabularyResult {
  const environment = createMappingEnvironment(input);
  if (environment.input.metadata.provider !== 'bangumi') {
    environment.pushGap({ path: '/sourceVocabulary/provider', reason: 'invalid_row' });
    return finishMapping(environment);
  }
  const seen = new Set<string>();
  const kinds = [
    'episode-sort',
    'episode-kind',
    'character-kind',
    'staff',
    'character-appearance',
    'voice-credit',
    'relation',
  ];
  const orderedRows = [...environment.rows].sort((left, right) => {
    const leftPath = environment.isRow(left, kinds)
      ? (environment.sourcePath((left as { path?: unknown }).path) ?? '')
      : '';
    const rightPath = environment.isRow(right, kinds)
      ? (environment.sourcePath((right as { path?: unknown }).path) ?? '')
      : '';
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  for (const row of orderedRows) {
    if (!environment.isRow(row, kinds)) {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
      continue;
    }
    try {
      mapRow(environment, row as BangumiVocabularyRow, seen);
    } catch {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
    }
  }
  return finishMapping(environment);
}
