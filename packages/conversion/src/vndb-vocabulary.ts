import { mapSourceEnumeration, vndbProducerParentEnds } from './cross-media-entities.ts';
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
import {
  vndbReleaseMediumCodes,
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from './support.ts';

export const vndbVocabularyRevision = 'vndb-vocabulary@2';
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
export const vndbAppearanceRoleCodes = Object.freeze(['main', 'primary', 'side', 'appears'] as const);
const appearanceRoles = new Set<string>(vndbAppearanceRoleCodes);
export const vndbAppearanceRoleSchemeUri = 'https://rezics.com/schemes/vndb/character-roles';

function conceptIdentity(value: ResolvedConcept): NativeIdentity {
  return { id: value.id, type: value.type, releaseDigest: value.releaseDigest };
}
function spoilerQualifier(value: number) {
  return { property: 'rezics:spoilerLevel', content: { amount: `+${value}`, unit: '1' } };
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
function rowGap(
  environment: MappingEnvironment,
  row: VndbVocabularyRow,
  reason: Parameters<MappingEnvironment['pushGap']>[0]['reason'],
  property?: string,
  code?: string,
  endpoint?: string,
) {
  environment.pushGap({
    path: environment.sourcePath(row.path) ?? '/sourceVocabulary/rows',
    reason,
    ...(code === undefined ? {} : { code }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(property === undefined ? {} : { property }),
  });
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

function mapRow(environment: MappingEnvironment, row: VndbVocabularyRow): void {
  const path = environment.sourcePath(row.path);
  if (!path) {
    rowGap(environment, row, 'invalid_row');
    return;
  }
  switch (row.kind) {
    case 'release-platform':
    case 'release-medium': {
      const code = environment.sourceCode(row.code);
      const platform = row.kind === 'release-platform';
      const property = platform ? 'schema:gamePlatform' : 'wdt:P437';
      if (code === null) {
        rowGap(
          environment,
          row,
          'invalid_source_value',
          platform ? 'releases_platforms.platform' : 'releases_media.medium',
        );
        return;
      }
      const admitted = platform
        ? (() => {
            const mapping = mapSourceEnumeration('vndb', 'platform', code);
            return mapping?.term === property;
          })()
        : vndbReleaseMediumCodes.has(code);
      if (!admitted) {
        rowGap(
          environment,
          row,
          'unknown_code',
          platform ? 'releases_platforms.platform' : 'releases_media.medium',
          code ?? undefined,
        );
        return;
      }
      const taxonomy = platform ? vndbReleasePlatformTaxonomy : vndbReleaseMediumTaxonomy;
      const schemeUri = platform ? vndbReleasePlatformSchemeUri : vndbReleaseMediumSchemeUri;
      const resolved = exactConcept(environment, taxonomy, code, path, schemeUri);
      if (resolved)
        environment.propose({
          row,
          subject: row.release,
          property,
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: `${row.kind}@1:${code}`,
        });
      return;
    }
    case 'release-date': {
      if (row.value === null) {
        rowGap(environment, row, 'unsupported_source_case', 'schema:datePublished', 'absent');
        return;
      }
      if (row.value === 'TBA' || row.value === 'unknown') {
        const code = row.value;
        if (!environment.admit(row.release, 'schema:keywords', path, code)) return;
        const resolved = exactConcept(environment, 'vndb.releases.released', code, path);
        if (resolved)
          environment.propose({
            row,
            subject: row.release,
            property: 'schema:keywords',
            content: resolved.id,
            target: conceptIdentity(resolved),
            mappingRevision: 'release-state@1',
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
      environment.propose({
        row,
        subject: row.release,
        property: 'schema:datePublished',
        content: date,
        mappingRevision: 'release-date@1',
      });
      return;
    }
    case 'development-status': {
      const code = environment.sourceCode(row.code);
      if (!code || !developmentStatus.has(row.code)) {
        rowGap(environment, row, 'unknown_code', 'vn.devstatus', code ?? undefined);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.development-status', code, path);
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: 'development-status@1',
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
        row,
        subject: row.release,
        property: 'wdt:P155',
        content: '',
        target: row.endpoint,
        sourceEndpoint: row.endpointCode,
        mappingRevision: 'release-supersedes@1',
      });
      return;
    }
    case 'release-work': {
      const code = environment.sourceCode(row.completenessCode);
      if (!code || !releaseTypes.has(code))
        rowGap(environment, row, 'unknown_code', 'releases_vn.rtype', code ?? undefined);
      else rowGap(environment, row, 'qualifier_not_admitted', 'wdt:P31', code);
      if (!row.work) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'schema:exampleOfWork',
          environment.sourceCode(row.workCode) ?? undefined,
          environment.sourceCode(row.workCode) ?? undefined,
        );
        return;
      }
      environment.propose({
        row,
        subject: row.release,
        property: 'schema:exampleOfWork',
        content: '',
        target: row.work,
        sourceEndpoint: row.workCode,
        mappingRevision: 'release-work@1',
      });
      return;
    }
    case 'staff': {
      const code = environment.sourceCode(row.roleCode);
      const property = code === null ? undefined : creditProperties[code];
      if (code === null || !property) {
        rowGap(environment, row, 'unknown_code', 'vn_staff.role', code ?? undefined);
        return;
      }
      if (!row.holder) {
        rowGap(
          environment,
          row,
          'missing_identity',
          property,
          environment.sourceCode(row.holderCode) ?? undefined,
          environment.sourceCode(row.holderCode) ?? undefined,
        );
        return;
      }
      if (row.holder.type !== 'schema:Person') {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.holderCode) ?? undefined,
          reason: 'incompatible_identity',
          property,
          requiredProfile: row.holder.type,
        });
        return;
      }
      const resolved = exactConcept(environment, 'vndb.credit_type', code, path);
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
          rowGap(environment, row, 'invalid_source_value', 'wdt:P1932', code);
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      environment.propose({
        row,
        subject: row.subject,
        property,
        content: '',
        target: row.holder,
        sourceEndpoint: row.holderCode,
        qualifiers,
        mappingRevision: 'staff-role@1',
      });
      return;
    }
    case 'voice-credit': {
      const performer = row.performer;
      if (!performer) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'wdt:P725',
          environment.sourceCode(row.performerCode) ?? undefined,
          environment.sourceCode(row.performerCode) ?? undefined,
        );
        return;
      }
      if (performer.type !== 'schema:Person' || !environment.identityId(performer)) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.performerCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P725',
          requiredProfile: performer.type,
        });
        return;
      }
      const character = row.character;
      if (!character) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'wdt:P453',
          environment.sourceCode(row.characterCode) ?? undefined,
          environment.sourceCode(row.characterCode) ?? undefined,
        );
        return;
      }
      const characterId = environment.identityId(character);
      if (!characterId) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.characterCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P453',
          requiredProfile: character.type,
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
          rowGap(environment, row, 'invalid_source_value', 'wdt:P1932');
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
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:genre',
          content: resolved.id,
          target: conceptIdentity(resolved),
          qualifiers: [spoilerQualifier(row.spoiler)],
          mappingRevision: 'tag@1',
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
      if (row.lie !== undefined && typeof row.lie !== 'boolean') {
        rowGap(environment, row, 'invalid_source_value', 'chars_traits.lie', code);
        return;
      }
      if (row.lie === true) {
        rowGap(environment, row, 'unsupported_source_case', 'chars_traits.lie', code);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.character-trait', code, path);
      if (resolved)
        environment.propose({
          row,
          subject: row.character,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          qualifiers: [spoilerQualifier(row.spoiler)],
          mappingRevision: 'character-trait@1',
        });
      return;
    }
    case 'character-appearance': {
      const role = environment.sourceCode(row.roleCode);
      if (!role || !appearanceRoles.has(role)) {
        rowGap(environment, row, 'unknown_code', 'chars_vns.role', role ?? undefined);
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', role);
        return;
      }
      const release =
        row.releaseCode === undefined || row.releaseCode === null ? null : environment.sourceCode(row.releaseCode);
      if (row.releaseCode !== undefined && row.releaseCode !== null && !release) {
        rowGap(environment, row, 'invalid_source_value', 'chars_vns.rid');
        return;
      }
      if (release) {
        rowGap(environment, row, 'unsupported_source_case', 'chars_vns.rid', release);
        return;
      }
      if (!row.character) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'schema:character',
          environment.sourceCode(row.characterCode) ?? undefined,
          environment.sourceCode(row.characterCode) ?? undefined,
        );
        return;
      }
      const resolved = exactConcept(environment, 'vndb.char_role', role, path, vndbAppearanceRoleSchemeUri);
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:character',
          content: '',
          target: row.character,
          sourceEndpoint: row.characterCode,
          qualifiers: [
            { property: 'wdt:P3831', content: resolved.id, identity: conceptIdentity(resolved) },
            spoilerQualifier(row.spoiler),
          ],
          mappingRevision: 'appearance-role@1',
        });
      return;
    }
    case 'producer-parent': {
      const code = environment.sourceCode(row.code);
      if (code !== 'par' && code !== 'sub') {
        rowGap(environment, row, 'unknown_code', 'producers_relations.relation', code ?? undefined);
        return;
      }
      const endpointCode = environment.sourceCode(row.endpointCode);
      if (!row.endpoint) {
        rowGap(environment, row, 'missing_identity', 'wdt:P749', code, endpointCode ?? undefined);
        return;
      }
      const orientation = vndbProducerParentEnds(code, row.subject.id, row.endpoint.id);
      if (!orientation) {
        rowGap(environment, row, 'unknown_code', 'producers_relations.relation', code);
        return;
      }
      const child = orientation.holder === row.subject.id ? row.subject : row.endpoint;
      const parent = orientation.target === row.subject.id ? row.subject : row.endpoint;
      if (child.type !== 'schema:Organization' || parent.type !== 'schema:Organization') {
        environment.pushGap({
          path,
          code,
          endpoint: endpointCode ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P749',
          requiredProfile: child.type !== 'schema:Organization' ? child.type : parent.type,
        });
        return;
      }
      environment.propose({
        row,
        subject: child,
        property: 'wdt:P749',
        content: '',
        target: parent,
        sourceEndpoint: row.endpointCode,
        mappingRevision: `producer-parent@1:${code}`,
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
  const kinds = [
    'release-date',
    'release-platform',
    'release-medium',
    'development-status',
    'release-supersedes',
    'release-work',
    'staff',
    'voice-credit',
    'tag',
    'character-trait',
    'character-appearance',
    'producer-parent',
  ];
  for (const row of environment.rows) {
    if (!environment.isRow(row, kinds)) {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
      continue;
    }
    try {
      mapRow(environment, row as VndbVocabularyRow);
    } catch {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
    }
  }
  return finishMapping(environment);
}
