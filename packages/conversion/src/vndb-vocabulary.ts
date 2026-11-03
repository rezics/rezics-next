import {
  createMappingEnvironment,
  finishMapping,
  type MappingEnvironment,
  type NativeIdentity,
  type ResolvedConcept,
  type SourceVocabularyInput,
  type SourceVocabularyResult,
  type VndbVocabularyRow,
} from './source-vocabulary.ts';

export const vndbVocabularyRevision = 'vndb-vocabulary@1';
const calendarModel = 'http://www.wikidata.org/entity/Q1985727';
const developmentStatus = new Map<number, string>([
  [0, 'Finished'],
  [1, 'In development'],
  [2, 'Cancelled'],
]);
const creditProperties: Readonly<Record<string, string>> = {
  scenario: 'schema:author',
  chardesign: 'schema:illustrator',
  art: 'schema:illustrator',
  music: 'schema:musicBy',
  songs: 'schema:musicBy',
  director: 'schema:director',
  translator: 'schema:translator',
  editor: 'schema:contributor',
  qa: 'schema:contributor',
  staff: 'schema:contributor',
};
const releaseTypes = new Set(['complete', 'partial', 'trial']);

function conceptIdentity(value: ResolvedConcept): NativeIdentity {
  return { id: value.id, type: value.type, releaseDigest: value.releaseDigest };
}
function spoilerQualifier(value: number) {
  return { property: 'rezics:spoilerLevel', content: { amount: String(value), unit: '1' } };
}
function dateValue(value: string): { time: string; precision: 9 | 10 | 11; calendarmodel: string } | null {
  if (value.startsWith('0000')) return null;
  if (/^[0-9]{4}$/u.test(value))
    return { time: `+${value}-00-00T00:00:00Z`, precision: 9, calendarmodel: calendarModel };
  if (/^[0-9]{4}-[0-9]{2}$/u.test(value)) {
    const month = Number(value.slice(5));
    if (month < 1 || month > 12) return null;
    return { time: `+${value}-00T00:00:00Z`, precision: 10, calendarmodel: calendarModel };
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return { time: `+${value}T00:00:00Z`, precision: 11, calendarmodel: calendarModel };
  }
  return null;
}
function rowGap(environment: MappingEnvironment, row: VndbVocabularyRow, reason: Parameters<MappingEnvironment['pushGap']>[0]['reason'], property?: string, code?: string, endpoint?: string) {
  environment.pushGap({
    path: environment.sourcePath(row.path) ?? '/sourceVocabulary/rows',
    reason,
    ...(code === undefined ? {} : { code }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(property === undefined ? {} : { property }),
  });
}
function exactConcept(environment: MappingEnvironment, taxonomy: string, code: string, path: string): ResolvedConcept | null {
  return environment.concept(taxonomy, code, path);
}

function mapRow(environment: MappingEnvironment, row: VndbVocabularyRow): void {
  const path = environment.sourcePath(row.path);
  if (!path) {
    rowGap(environment, row, 'invalid_row');
    return;
  }
  switch (row.kind) {
    case 'release-date': {
      if (row.value === null) {
        rowGap(environment, row, 'unsupported_source_case', 'schema:datePublished', 'absent');
        return;
      }
      if (row.value === 'TBA' || row.value === 'unknown') {
        const code = row.value;
        if (!environment.admit(row.release, 'schema:keywords', path, code)) return;
        const resolved = exactConcept(environment, 'vndb.releases.released', code, path);
        if (resolved) environment.propose({
          row, subject: row.release, property: 'schema:keywords', content: resolved.id,
          target: conceptIdentity(resolved), mappingRevision: 'release-state@1',
        });
        return;
      }
      if (typeof row.value !== 'string') {
        rowGap(environment, row, 'invalid_source_value', 'schema:datePublished');
        return;
      }
      const date = dateValue(row.value);
      if (!date) {
        rowGap(environment, row, 'invalid_source_value', 'schema:datePublished');
        return;
      }
      environment.propose({ row, subject: row.release, property: 'schema:datePublished', content: date, mappingRevision: 'release-date@1' });
      return;
    }
    case 'development-status': {
      const code = environment.sourceCode(row.code);
      if (!code || !developmentStatus.has(row.code)) {
        rowGap(environment, row, 'unknown_code', 'vn.devstatus', code ?? undefined);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.development-status', code, path);
      if (resolved) environment.propose({
        row, subject: row.subject, property: 'schema:keywords', content: resolved.id,
        target: conceptIdentity(resolved), mappingRevision: 'development-status@1',
      });
      return;
    }
    case 'release-supersedes': {
      const endpoint = environment.sourceCode(row.endpointCode);
      if (!row.endpoint) {
        rowGap(environment, row, 'missing_identity', 'wdt:P155', endpoint ?? undefined, endpoint ?? undefined);
        return;
      }
      environment.propose({
        row, subject: row.release, property: 'wdt:P155', content: '', target: row.endpoint, sourceEndpoint: row.endpointCode,
        mappingRevision: 'release-supersedes@1',
      });
      return;
    }
    case 'release-work': {
      const code = environment.sourceCode(row.completenessCode);
      if (!code || !releaseTypes.has(code)) rowGap(environment, row, 'unknown_code', 'releases_vn.rtype', code ?? undefined);
      else rowGap(environment, row, 'qualifier_not_admitted', 'wdt:P31', code);
      if (!row.work) {
        rowGap(environment, row, 'missing_identity', 'schema:exampleOfWork', environment.sourceCode(row.workCode) ?? undefined, environment.sourceCode(row.workCode) ?? undefined);
        return;
      }
      environment.propose({
        row, subject: row.release, property: 'schema:exampleOfWork', content: '', target: row.work, sourceEndpoint: row.workCode,
        mappingRevision: 'release-work@1',
      });
      return;
    }
    case 'staff': {
      const code = environment.sourceCode(row.roleCode);
      const property = code === null ? undefined : creditProperties[code];
      if (!property) {
        rowGap(environment, row, 'unknown_code', 'vn_staff.role', code ?? undefined);
        return;
      }
      if (!row.holder) {
        rowGap(environment, row, 'missing_identity', property, environment.sourceCode(row.holderCode) ?? undefined, environment.sourceCode(row.holderCode) ?? undefined);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.credit_type', code, path);
      if (!resolved) return;
      const qualifiers: { property: string; content: unknown; identity?: NativeIdentity }[] = [
        { property: 'wdt:P3831', content: resolved.id, identity: conceptIdentity(resolved) },
      ];
      if (row.creditedAs !== undefined) {
        if (typeof row.creditedAs !== 'string' || !row.creditedAs.isWellFormed() || !row.creditedAs.trim() || row.creditedAs.length > 1500) {
          rowGap(environment, row, 'invalid_source_value', 'wdt:P1932', code);
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      environment.propose({ row, subject: row.subject, property, content: '', target: row.holder, sourceEndpoint: row.holderCode, qualifiers, mappingRevision: 'staff-role@1' });
      return;
    }
    case 'tag': {
      const code = environment.sourceCode(row.code);
      if (!code) {
        rowGap(environment, row, 'invalid_source_value', 'tags_vn.tag');
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', code);
        return;
      }
      if (row.category !== 'cont' && row.category !== 'ero' && row.category !== 'tech') {
        rowGap(environment, row, 'unknown_code', 'tags.category');
        return;
      }
      const resolved = exactConcept(environment, `vndb.tag.${row.category}`, code, path);
      if (resolved) environment.propose({
        row, subject: row.subject, property: 'schema:genre', content: resolved.id,
        target: conceptIdentity(resolved), qualifiers: [spoilerQualifier(row.spoiler)], mappingRevision: 'tag@1',
      });
      return;
    }
    case 'character-trait': {
      const code = environment.sourceCode(row.code);
      if (!code) {
        rowGap(environment, row, 'invalid_source_value', 'chars_traits.tid');
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', code);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.character-trait', code, path);
      if (resolved) environment.propose({
        row, subject: row.character, property: 'schema:keywords', content: resolved.id,
        target: conceptIdentity(resolved), qualifiers: [spoilerQualifier(row.spoiler)], mappingRevision: 'character-trait@1',
      });
      return;
    }
  }
}

/** Maps normalized caller-owned VNDB rows and never follows release/work/person endpoints. */
export function mapVndbVocabulary(input: SourceVocabularyInput): SourceVocabularyResult {
  const environment = createMappingEnvironment(input);
  if (environment.input.metadata.provider !== 'vndb') {
    environment.pushGap({ path: '/sourceVocabulary/provider', reason: 'invalid_row' });
    return finishMapping(environment);
  }
  const kinds = ['release-date', 'development-status', 'release-supersedes', 'release-work', 'staff', 'tag', 'character-trait'];
  for (const row of environment.rows) {
    if (!environment.isRow(row, kinds)) {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
      continue;
    }
    try { mapRow(environment, row as VndbVocabularyRow); }
    catch { environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' }); }
  }
  return finishMapping(environment);
}
