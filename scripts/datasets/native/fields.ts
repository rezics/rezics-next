import type { SemanticProperty } from '../../../services/main/src/modules/semantic/change.ts';
import {
  checkedSemanticValue,
  exactFromEvidence,
  type SemanticValue,
} from '../../../services/main/src/modules/semantic/value.ts';
import type { StatementValue } from '../../../services/main/src/modules/statement/schema.ts';
import { BANGUMI_USER_POST_FIELDS, bangumiSkipReason } from '../bangumi.ts';
import { canonical, sha256 } from '../store.ts';
import type { DatasetRecord, DatasetSourceReference } from '../types.ts';
import { datasetRecordDigest } from './context.ts';
import { validSynopsisText, suppliedLanguage, synopsisPropertyValue } from '../../../services/main/src/modules/source/field-control-language.ts';
import { projectDatasetReleases } from './releases.ts';
import { episodeRational, episodeKindCode, type EpisodeOccurrenceField } from '../../../services/main/src/modules/source/field-support-episode.ts';

const SCHEMA = 'https://schema.org/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const MILLISECOND = 'http://qudt.org/vocab/unit/MilliSEC';

export type SourceFieldPresence =
  | 'value'
  | 'omitted'
  | 'null'
  | 'empty-string'
  | 'empty-array'
  | 'empty-object';

export interface DatasetFieldEvidence {
  source: DatasetSourceReference;
  /** Pointer into the retained DatasetRecord, not an invented provider response. */
  path: string;
  /** Absent only for an omitted field. Null and empty values have their own digest. */
  valueDigest?: string;
  sourceUrl: string;
  /** Keep null, an omitted language, and a supplied spelling distinct. */
  language?: string | null;
  /** A line within an alias string is not a fictitious JSON array element. */
  ordinal?: number;
}

export interface DatasetNativeField {
  role: string;
  presence: SourceFieldPresence;
  evidence: DatasetFieldEvidence[];
  disposition: 'candidate' | 'source-only' | 'unmapped' | 'delegated';
  reason: string;
  /** A candidate is not adoption, publication, rights clearance or a support receipt. */
  native?: {
    owner: 'work-metadata' | 'work-editorial' | 'semantic' | 'statement' | 'release' | 'realization' | 'structure';
    occurrenceField?: EpisodeOccurrenceField;
    property?: SemanticProperty;
    statementValue?: StatementValue;
    predicate: string;
    material: 'fact' | 'expression';
  };
}

export interface DatasetFieldPlan {
  source: DatasetSourceReference;
  /** No coverage/adoption count: structural paths are not independent facts. */
  fields: DatasetNativeField[];
}

type Row = Record<string, unknown>;
const object = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
const token = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const child = (path: string, key: string | number) => `${path}/${token(String(key))}`;

function presence(value: unknown, exists: boolean): SourceFieldPresence {
  if (!exists) return 'omitted';
  if (value === null) return 'null';
  if (value === '') return 'empty-string';
  if (Array.isArray(value) && !value.length) return 'empty-array';
  if (object(value) && !Object.keys(value as Row).length) return 'empty-object';
  return 'value';
}

function languageValue(lexical: string, language: string | null | undefined): SemanticValue {
  // A missing/invalid source language is not the UI locale. The evidence keeps
  // the exact supplied spelling even when the native codec needs canonical BCP47.
  let tag: string | undefined;
  if (language) {
    try {
      tag = Intl.getCanonicalLocales(language)[0];
    } catch {
      /* undetermined */
    }
  }
  return checkedSemanticValue(
    tag && !['mul', 'other', 'unknown'].includes(tag)
      ? { kind: 'language-string', lexical, language: tag }
      : { kind: 'string', lexical },
  );
}

/** JSON numbers beyond safe integers cannot recover the captured decimal lexical.
 * Decimal strings go through the existing exact codec, never Number/parseFloat. */
function exact(value: unknown): SemanticValue {
  const lexical =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : null;
  if (lexical === null) throw new Error('An exact decimal lexical is required');
  return checkedSemanticValue(exactFromEvidence(lexical).value);
}

function dateValue(value: unknown, packed = false): SemanticValue {
  let lexical =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (packed) {
    if (!/^[0-9]{8}$/.test(lexical) || lexical === '99999999')
      throw new Error('Unknown source date');
    const year = lexical.slice(0, 4),
      month = lexical.slice(4, 6),
      day = lexical.slice(6, 8);
    if (month === '99' && day !== '99') throw new Error('Invalid source date precision');
    lexical = month === '99' ? year : day === '99' ? `${year}-${month}` : `${year}-${month}-${day}`;
  }
  const precision = /^\d{4}$/.test(lexical)
    ? 'year'
    : /^\d{4}-\d{2}$/.test(lexical)
      ? 'month'
      : 'day';
  return checkedSemanticValue({ kind: 'temporal', lexical, precision, calendar: 'gregorian' });
}

function statementValue(value: SemanticValue): StatementValue | undefined {
  if ('lexical' in value && value.lexical.length > 4096) return undefined;
  if (value.kind === 'language-string' && !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value.language))
    return undefined;
  switch (value.kind) {
    case 'string':
      return { kind: 'literal', lexical: value.lexical, datatype: `${XSD}string`, language: null };
    case 'language-string':
      return {
        kind: 'literal',
        lexical: value.lexical,
        datatype: `${RDF}langString`,
        language: value.language,
      };
    case 'integer':
    case 'decimal':
    case 'boolean':
      return {
        kind: 'literal',
        lexical: value.lexical,
        datatype: `${XSD}${value.kind}`,
        language: null,
      };
    case 'temporal':
      return {
        kind: 'literal',
        lexical: value.lexical,
        datatype: `${XSD}${value.precision === 'year' ? 'gYear' : value.precision === 'month' ? 'gYearMonth' : 'date'}`,
        language: null,
      };
    default:
      return undefined;
  }
}

/** Pure producer adapter over the shared import context's exact source reference.
 * Consumers select existing metadata/semantic/Statement commands and retain the
 * field evidence alongside their acknowledged source-support receipts. This plan
 * deliberately cannot replace a native head or decide reuse/acceptance authority.
 */
export function projectDatasetFields(
  record: DatasetRecord,
  source: DatasetSourceReference,
  options: { releaseCorrespondence?: boolean } = {},
): DatasetFieldPlan {
  if (
    source.key !== record.key ||
    source.provider !== record.provider ||
    source.namespace !== record.kind ||
    source.externalId !== record.externalId ||
    source.recordDigest !== datasetRecordDigest(record)
  ) {
    throw new Error('Field projection requires the exact retained source record');
  }
  const fields: DatasetNativeField[] = [];
  const covered = new Set<string>();
  const evidence = (
    path: string,
    value: unknown,
    exists: boolean,
    language?: string | null,
    ordinal?: number,
  ): DatasetFieldEvidence => ({
    source: structuredClone(source),
    path,
    sourceUrl: record.sourceUrl,
    ...(exists ? { valueDigest: sha256(canonical(value)) } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(ordinal !== undefined ? { ordinal } : {}),
  });
  const retain = (
    path: string,
    value: unknown,
    reason: string,
    disposition: DatasetNativeField['disposition'] = 'source-only',
    role = 'source-field',
    exists = true,
  ) => {
    covered.add(path);
    fields.push({
      role,
      presence: presence(value, exists),
      evidence: [evidence(path, value, exists)],
      disposition,
      reason,
    });
  };
  const emit = (
    path: string,
    raw: unknown,
    role: string,
    predicate: string,
    convert: (value: unknown) => SemanticValue,
    options: {
      exists?: boolean;
      language?: string | null;
      ordinal?: number;
      expression?: boolean;
      owner?: NonNullable<DatasetNativeField['native']>['owner'];
    } = {},
  ) => {
    covered.add(path);
    const state = presence(raw, options.exists ?? true);
    const item: DatasetNativeField = {
      role,
      presence: state,
      evidence: [evidence(path, raw, options.exists ?? true, options.language, options.ordinal)],
      disposition: 'source-only',
      reason: `Source field is ${state}`,
    };
    fields.push(item);
    if (state !== 'value') return;
    if (role === 'description' && record.native === 'work') {
      if (!validSynopsisText(raw)) {
        item.disposition = 'unmapped';
        item.reason = 'Exact synopsis exceeds the native text contract or contains unsupported controls; retained without alteration';
        return;
      }
      const language = suppliedLanguage(item.evidence[0]!);
      item.native = { owner: 'work-editorial', predicate,
        property: { predicate, value: synopsisPropertyValue(raw, language) }, material: 'expression' };
      item.disposition = 'candidate';
      item.reason = 'Lossless editorial synopsis candidate; supplied language and rights admission remain independent';
      return;
    }
    try {
      const value = convert(raw);
      const owner =
        options.owner ??
        (record.native === 'work' && ['name', 'aliases', 'description'].includes(role)
          ? 'work-metadata'
          : 'semantic');
      if (
        owner === 'work-metadata' &&
        (value.kind !== 'language-string' ||
          !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value.language) ||
          value.lexical.length > (role === 'description' ? 4000 : 500) ||
          /[\u0000-\u001f\u007f]/.test(value.lexical))
      ) {
        item.disposition = 'unmapped';
        item.reason =
          'Existing Work metadata needs tagged, bounded single-line text; exact source retained without truncation or a guessed language';
        return;
      }
      const literal = statementValue(value);
      item.native = {
        owner,
        predicate,
        property: { predicate, value },
        ...(literal ? { statementValue: literal } : {}),
        material: options.expression ? 'expression' : 'fact',
      };
      item.disposition = 'candidate';
      item.reason = options.expression
        ? 'Expression candidate; exact field reuse requires the rights owner'
        : 'Exact native value candidate; adoption and source support remain separate';
    } catch {
      item.disposition = 'unmapped';
      item.reason =
        'Source value does not satisfy the existing native value codec; retained without coercion';
    }
  };
  const text = (
    row: Row,
    base: string,
    key: string,
    role: string,
    predicate: string,
    language: string | null | undefined,
    expression = false,
    nativeLanguage: string | null | undefined = language,
  ) =>
    emit(
      child(base, key),
      row[key],
      role,
      predicate,
      (value) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('Expected source text');
        return languageValue(value, nativeLanguage);
      },
      { exists: Object.hasOwn(row, key), language, expression },
    );
  const number = (
    row: Row,
    base: string,
    key: string,
    role: string,
    predicate: string,
    zeroUnknown = false,
    unit?: string,
  ) => {
    const path = child(base, key),
      raw = row[key];
    if (zeroUnknown && (raw === 0 || raw === '0')) {
      retain(
        path,
        raw,
        'Provider zero is an unknown sentinel, not a measured zero',
        'source-only',
        role,
      );
      return;
    }
    emit(
      path,
      raw,
      role,
      predicate,
      (value) => {
        const measured = exact(value);
        if (measured.kind !== 'integer' && measured.kind !== 'decimal')
          throw new Error('Expected number');
        if (measured.lexical.startsWith('-')) throw new Error('Expected nonnegative amount');
        return unit
          ? checkedSemanticValue({
              kind: 'quantity',
              lexical: String(value),
              value: measured,
              unit,
            })
          : measured;
      },
      { exists: Object.hasOwn(row, key) },
    );
  };
  const date = (
    row: Row,
    base: string,
    key: string,
    role: string,
    predicate: string,
    packed = false,
  ) => {
    const raw = row[key],
      path = child(base, key);
    if (packed && (raw === 0 || raw === '0' || raw === 99999999 || raw === '99999999')) {
      retain(
        path,
        raw,
        'Provider date sentinel is unknown/TBA, never a Gregorian date',
        'source-only',
        role,
      );
      return;
    }
    emit(path, raw, role, predicate, (value) => dateValue(value, packed), {
      exists: Object.hasOwn(row, key),
    });
  };
  const aliases = (row: Row, base: string, key: string, language?: string | null) => {
    const value = row[key],
      path = child(base, key);
    if (typeof value === 'string' && value.includes('\n')) {
      value.split(/\r?\n/).forEach((line, ordinal) =>
        emit(
          path,
          value,
          'aliases',
          `${SCHEMA}alternateName`,
          () => {
            if (!line.trim()) throw new Error('Empty alias line');
            return languageValue(line, language);
          },
          { language, ordinal },
        ),
      );
    } else if (Array.isArray(value)) {
      if (!value.length) retain(path, value, 'Source alias inventory is empty');
      value.forEach((alias, index) => {
        const position = child(path, index),
          aliasRow = object(alias);
        if (aliasRow) {
          const locale = Object.hasOwn(aliasRow, 'locale') ? aliasRow.locale : language;
          const lang = typeof locale === 'string' || locale === null ? locale : undefined;
          text(
            aliasRow,
            position,
            Object.hasOwn(aliasRow, 'v') ? 'v' : 'name',
            'aliases',
            `${SCHEMA}alternateName`,
            lang,
          );
          if (Object.hasOwn(aliasRow, 'sort-name'))
            text(aliasRow, position, 'sort-name', 'sort-name', `${SKOS}hiddenLabel`, lang);
        } else
          emit(
            position,
            alias,
            'aliases',
            `${SCHEMA}alternateName`,
            (v) => {
              if (typeof v !== 'string' || !v.trim()) throw new Error('Expected alias');
              return languageValue(v, language);
            },
            { language },
          );
      });
    } else text(row, base, key, 'aliases', `${SCHEMA}alternateName`, language);
  };

  if (
    ['blog', 'post', 'review', 'comment', 'quote', 'thread', 'discussion'].includes(record.kind)
  ) {
    retain(
      '/data',
      record.data,
      'User expression is retained evidence, never a descriptive native field',
    );
    return { source: structuredClone(source), fields };
  }

  emit(
    '/title',
    record.title,
    'name',
    `${SCHEMA}name`,
    (v) => {
      if (typeof v !== 'string' || !v.trim()) throw new Error('Expected source name');
      return languageValue(v, record.language);
    },
    { language: record.language },
  );

  if (record.provider === 'vndb') {
    for (const key of ['name', 'original'] as const) if (Object.hasOwn(record.data,key)) {
      text(record.data,'/data',key,key === 'name' ? 'name' : 'aliases',
        `${SCHEMA}${key === 'name' ? 'name' : 'alternateName'}`,undefined);
    }
    text(
      record.data,
      '/data',
      'description',
      'description',
      `${SCHEMA}description`,
      typeof record.data.description_language === 'string' ||
        record.data.description_language === null
        ? record.data.description_language
        : undefined,
      true,
    );
    // A Work's original language does not establish the language of each alias.
    aliases(record.data, '/data', 'alias');
    aliases(record.data, '/data', 'aliases');
    if (record.kind === 'vn')
      text(record.data, '/data', 'olang', 'original-language', `${SCHEMA}inLanguage`, undefined);
    if (record.kind === 'producer')
      text(record.data, '/data', 'lang', 'language', `${SCHEMA}inLanguage`, undefined);
    if (record.kind === 'producer' || record.kind === 'staff')
      text(record.data, '/data', 'country', 'country', `${SCHEMA}countryOfOrigin`, undefined);
    if (record.kind === 'release' || record.kind === 'vn')
      date(record.data, '/data', 'released', 'release-date', `${SCHEMA}datePublished`, true);
    if (record.kind === 'character') {
      for (const key of ['height', 'weight'] as const) {
        // VNDB's zero is unknown. Keep the field's native quantity and unit;
        // appearance/trait/gender interpretation belongs to qualified relations.
        number(
          record.data,
          '/data',
          key,
          key,
          `${SCHEMA}${key}`,
          true,
          `http://qudt.org/vocab/unit/${key === 'weight' ? 'KiloGM' : 'CentiM'}`,
        );
      }
      date(record.data, '/data', 'birthdate', 'birth-date', `${SCHEMA}birthDate`);
      if (Object.hasOwn(record.data, 'b_month') || Object.hasOwn(record.data, 'b_day')) {
        const month = record.data.b_month,
          day = record.data.b_day;
        const paths = ['/data/b_month', '/data/b_day'];
        const item: DatasetNativeField = {
          role: 'birth-date',
          presence: 'value',
          evidence: paths.map((path, index) =>
            evidence(
              path,
              index === 0 ? month : day,
              Object.hasOwn(record.data, index === 0 ? 'b_month' : 'b_day'),
            ),
          ),
          disposition: 'source-only',
          reason: 'Partial/unknown birthday retained without inventing a year',
        };
        paths.forEach((path) => covered.add(path));
        fields.push(item);
        if (
          /^(0?[1-9]|1[0-2])$/.test(String(month)) &&
          /^(0?[1-9]|[12][0-9]|3[01])$/.test(String(day))
        ) {
          const suffix = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          try {
            // Leap year validates month/day without asserting any birth year.
            dateValue(`2000-${suffix}`);
            item.native = {
              owner: 'statement',
              predicate: `${SCHEMA}birthDate`,
              material: 'fact',
              statementValue: {
                kind: 'literal',
                lexical: `--${suffix}`,
                datatype: `${XSD}gMonthDay`,
                language: null,
              },
            };
            item.disposition = 'candidate';
            item.reason = 'Exact month/day Statement candidate; no birth year asserted';
          } catch {
            /* Keep an impossible birthday source-only. */
          }
        }
      }
    }
    const tables = object(record.data.tables);
    for (const table of [
      'vn_titles',
      'releases_titles',
      'chars_names',
      'chars_alias',
      'staff_alias',
    ]) {
      const rows = tables?.[table];
      if (!Array.isArray(rows)) continue;
      rows.forEach((value, index) => {
        const row = object(value);
        if (!row) return;
        const path = `/data/tables/${table}/${index}`;
        const language = typeof row.lang === 'string' ? row.lang : undefined;
        const key = Object.hasOwn(row, 'title') ? 'title' : 'name';
        text(row, path, key, 'aliases', `${SCHEMA}alternateName`, language);
        if (Object.hasOwn(row, 'latin')) {
          let latinLanguage = 'und-Latn';
          try {
            if (language) latinLanguage = `${new Intl.Locale(language).language}-Latn`;
          } catch {
            /* The source's script column still identifies Latin text. */
          }
          // Keep the supplied language in evidence; the Latin column supplies
          // the native script refinement, not a new source-language assertion.
          text(
            row,
            path,
            'latin',
            'aliases',
            `${SCHEMA}alternateName`,
            language,
            false,
            latinLanguage,
          );
        }
      });
    }
  } else if (record.provider === 'bangumi') {
    const rows: [Row, string][] = [[record.data, '/data']];
    const api = object(record.data.api_subject);
    if (api) rows.push([api, '/data/api_subject']);
    for (const [row, base] of rows) {
      text(row, base, 'name', 'name', `${SCHEMA}name`, record.language);
      text(row, base, 'name_cn', 'aliases', `${SCHEMA}alternateName`, 'zh-Hans');
      text(
        row,
        base,
        'summary',
        'description',
        `${SCHEMA}description`,
        Object.hasOwn(row, 'summary_language')
          ? typeof row.summary_language === 'string' || row.summary_language === null
            ? row.summary_language
            : undefined
          : 'zh-Hans',
        true,
      );
      aliases(row, base, 'aliases');
      date(
        row,
        base,
        record.kind === 'episode' ? 'airdate' : 'date',
        record.kind === 'episode' ? 'air-date' : 'release-date',
        `${SCHEMA}datePublished`,
      );
      if (record.kind === 'episode') {
        if (base === '/data') for (const [key, name] of [
          ['sort','position'], ['disc','disc'], ['type','kindCode'],
        ] as const) {
          const path = child(base,key), raw = row[key], exists = Object.hasOwn(row,key);
          covered.add(path);
          const valid = name === 'kindCode' ? episodeKindCode(raw) !== null : episodeRational(raw,name === 'disc') !== null;
          const item: DatasetNativeField = { role: `episode-${name}`,presence: presence(raw,exists),
            evidence: [evidence(path,raw,exists)],disposition: valid ? 'candidate' : 'source-only',
            reason: valid ? 'Exact occurrence qualifier candidate; original placement and acknowledged native receipt required'
              : 'No exact admitted occurrence value; source presence and value remain unchanged' };
          let property: SemanticProperty | undefined;
          if (valid && name === 'position') {
            try { property = { predicate: 'qualifier.values.position',value: exact(String(raw)) }; }
            catch { /* Scientific JSON spelling remains an exact occurrence candidate. */ }
          }
          if (valid) item.native = { owner: 'structure',predicate: `qualifier.values.${name}`,occurrenceField: name,
            material: 'fact',
            // Preserve the existing readable source number, independently of semantic episodeNumber and sibling order.
            ...(property ? { property } : {}) };
          fields.push(item);
        }
        // The archive duration is human text (e.g. 00:24:00), not minutes.
        text(row, base, 'duration', 'duration', `${SCHEMA}duration`, undefined);
      }
      for (const key of ['eps', 'volumes'])
        if (Object.hasOwn(row, key))
          number(
            row,
            base,
            key,
            key === 'eps' ? 'episode-count' : 'volume-count',
            `${SCHEMA}${key === 'eps' ? 'numberOfEpisodes' : 'numberOfItems'}`,
            true,
          );
      const infobox = row.infobox;
      if (Array.isArray(infobox))
        infobox.forEach((value, index) => {
          const entry = object(value),
            path = `${base}/infobox/${index}`;
          if (!entry) return;
          if (entry.key === '别名') aliases(entry, path, 'value');
          if (entry.key === '中文名')
            text(entry, path, 'value', 'aliases', `${SCHEMA}alternateName`, 'zh-Hans');
        });
    }
  } else if (record.provider === 'musicbrainz') {
    for (const key of ['name','title'] as const) if (Object.hasOwn(record.data,key)) {
      text(record.data,'/data',key,'name',`${SCHEMA}name`,undefined);
    }
    aliases(record.data, '/data', 'aliases');
    text(record.data, '/data', 'sort-name', 'sort-name', `${SKOS}hiddenLabel`, undefined);
    text(
      record.data,
      '/data',
      'disambiguation',
      'disambiguation',
      `${SCHEMA}disambiguatingDescription`,
      undefined,
    );
    // Annotation is expression, never a replacement for a missing synopsis.
    text(
      record.data,
      '/data',
      'annotation',
      'annotation',
      'http://www.w3.org/2000/01/rdf-schema#comment',
      undefined,
      true,
    );
    if (record.kind === 'recording')
      number(record.data, '/data', 'length', 'length', `${SCHEMA}duration`, false, MILLISECOND);
    if (record.kind === 'label')
      number(record.data, '/data', 'label-code', 'label-code', `${SCHEMA}identifier`);
    for (const [key, role] of [
      ['isrcs', 'isrc'],
      ['iswcs', 'iswc'],
    ] as const) {
      const values = record.data[key];
      if (Array.isArray(values))
        values.forEach((value, index) =>
          emit(`/data/${key}/${index}`, value, role, `${SCHEMA}${role}`, (raw) => {
            if (typeof raw !== 'string') throw new Error('Expected identifier');
            return checkedSemanticValue({ kind: 'string', lexical: raw });
          }),
        );
    }
    for (const key of ['date', 'first-release-date'])
      if (Object.hasOwn(record.data, key))
        date(record.data, '/data', key, 'release-date', `${SCHEMA}datePublished`);
    const lifespan = object(record.data['life-span']);
    if (lifespan) {
      date(
        lifespan,
        '/data/life-span',
        'begin',
        'begin-date',
        `${SCHEMA}${record.native === 'person' ? 'birthDate' : 'foundingDate'}`,
      );
      date(
        lifespan,
        '/data/life-span',
        'end',
        'end-date',
        `${SCHEMA}${record.native === 'person' ? 'deathDate' : 'dissolutionDate'}`,
      );
    }
    const representation = object(record.data['text-representation']);
    if (representation)
      text(
        representation,
        '/data/text-representation',
        'language',
        'language',
        `${SCHEMA}inLanguage`,
        undefined,
      );
    const area = object(record.data.area);
    if (area) text(area, '/data/area', 'name', 'area', `${SCHEMA}location`, undefined);
    if (Object.hasOwn(record.data, 'country'))
      text(record.data, '/data', 'country', 'country', `${SCHEMA}countryOfOrigin`, undefined);
    if (record.kind === 'work')
      text(record.data, '/data', 'language', 'language', `${SCHEMA}inLanguage`, undefined);
  }

  const social = new Set([
    'rating',
    'ratings',
    'score',
    'votes',
    'votecount',
    'popularity',
    'rank',
    'collection',
    'collections',
    'collects',
    'stat',
    'stats',
    'statistic',
    'statistics',
    'wishes',
    'wish',
    'doing',
    'done',
    'on_hold',
    'dropped',
    'locked',
    ...BANGUMI_USER_POST_FIELDS,
  ]);
  const delegated = new Set([
    'relations',
    'characters',
    'staff',
    'persons',
    'tags',
    'traits',
    'artist-credit',
    'media',
    'tracks',
    'release-events',
    'release-group',
    'label-info',
    'images',
    'image',
    'cover',
    'avatar',
    'recipeIngredient',
    'recipeInstructions',
    'nutrition',
  ]);
  const inspect = (value: unknown, path: string, key: string) => {
    if (covered.has(path)) return;
    if (social.has(key) || (record.provider === 'bangumi' && bangumiSkipReason(key))) {
      retain(
        path,
        value,
        'Source activity, user expression or media has no descriptive field adoption',
      );
      return;
    }
    if (
      delegated.has(key) ||
      (path.startsWith('/data/tables/') &&
        !/^\/data\/tables\/(vn_titles|releases_titles|chars_names|chars_alias|staff_alias)(\/|$)/.test(
          path,
        ))
    ) {
      retain(
        path,
        value,
        'Qualified relationship, media or ordered/domain owner retains this field',
        'delegated',
      );
      return;
    }
    if (Array.isArray(value) && value.length)
      value.forEach((item, index) => inspect(item, child(path, index), key));
    else if (object(value) && Object.keys(value as Row).length) {
      for (const [key, item] of Object.entries(value as Row)) inspect(item, child(path, key), key);
    } else if (presence(value, true) !== 'value')
      retain(path, value, `Source field is ${presence(value, true)}`);
    else
      retain(
        path,
        value,
        'No reviewed field binding; exact source evidence remains available',
        'unmapped',
      );
  };
  // Consume the release owner's existing pure correspondence. Edition facts
  // stay on their actual release/covered realization, with the same exact date
  // precision and supplied language; this creates no native admission.
  if (record.native === 'release' && options.releaseCorrespondence !== false) {
    const release = projectDatasetReleases(record,source);
    if (release.grain === 'release') for (const fact of release.facts) {
      if (fact.gap || fact.normalized === undefined) continue;
      const options: Parameters<typeof emit>[5] = { owner: 'release' };
      let predicate: string, value: SemanticValue;
      if (fact.role === 'title') {
        predicate = `${SCHEMA}name`; value = languageValue(record.title,record.language);
        options.language = record.language; options.expression = true;
      } else if (fact.role === 'publication-date' && fact.precision === 'year' && typeof fact.normalized === 'string') {
        predicate = `${SCHEMA}datePublished`;
        value = { kind: 'temporal',lexical: fact.normalized,precision: 'year',calendar: 'gregorian' };
      } else if (['status','platform','territory','language'].includes(fact.role) && typeof fact.normalized === 'string') {
        predicate = `https://rezics.com/vocab/${fact.role === 'status' ? 'releaseStatus'
          : fact.role === 'language' ? 'contentLanguage' : fact.role}`;
        value = { kind: 'string',lexical: fact.normalized };
        if (fact.role === 'language') options.owner = 'realization';
      } else continue;
      emit(fact.occurrence.path,fact.value,`release-${fact.role}`,predicate,() => checkedSemanticValue(value),options);
    }
  }
  for (const [key, value] of Object.entries(record.data)) inspect(value, child('/data', key), key);
  return { source: structuredClone(source), fields };
}
