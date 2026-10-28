import { checkBatchWrite, type BatchCommand, type BatchReference, type BatchStatement } from '@rezics/definitions/bulk';
import { ConversionError, type ConversionInput, type ConvertedRecord, type ConversionDiagnostic } from './index.ts';
import {
  canonicalLanguageTag,
  commandKey,
  inLanguageTag,
  safeSourceUrl,
  sourceDigest,
  sourceEnvelope,
  type ConversionContext,
} from './support.ts';

export const converter_revision = 'vndb@6';
export const vndbLimits = Object.freeze({
  maxTitles: 64,
  maxTitleCandidates: 64,
  maxLinks: 32,
  stringBytes: 4096,
  recordBytes: 64 * 1024,
  // One identifier + 64 title candidates + 32 links + one original language = 98 of 100.
  maxCommands: 98,
});

type Title = { id: string; lang: string; official: boolean; title: string; latin: string | null };
type NormalizedRecord = {
  vn: { id: string; olang?: string; c_votecount?: number; c_average?: number | null };
  entry_meta: { id: string; revision: number; lastmod?: string };
  vn_titles: Title[];
  vn_extlinks: { id: string; link: number }[];
  extlinks: { id: number; site: string; value: string }[];
};
export type VndbConversion = ConvertedRecord<BatchCommand> & {
  digest: string;
  normalizedRecord: NormalizedRecord;
  assets: readonly [];
  sourceMetadata: { databaseLicense: string; contentsLicense: string; attribution: string };
};
export type VndbOptions = { readonly converterRevision?: string };
const fail = (code: string, pointer: string): never => {
  throw new ConversionError(code, pointer);
};

function row(value: unknown, pointer: string): object {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('Expected a plain dump row', pointer);
  return value as object;
}
// Read only declared own data fields. Unknown fields (including accessors) are never visited.
function field(value: object, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) fail('Expected a dump data field', pointer);
  return descriptor.value;
}
function text(value: unknown, pointer: string): string {
  if (
    typeof value !== 'string' ||
    value.length > vndbLimits.stringBytes ||
    !value.isWellFormed() ||
    !value.length ||
    Buffer.byteLength(value, 'utf8') > vndbLimits.stringBytes
  )
    fail('Invalid or oversized dump text', pointer);
  return value as string;
}
function titleText(value: unknown, pointer: string): string {
  const result = text(value, pointer);
  if ([...result].length > 1500 || !result.trim()) fail('Invalid or oversized title', pointer);
  return result;
}
function nativeId(value: unknown, pointer: string): string {
  const result = text(value, pointer);
  if (result.length > 32 || !/^v[1-9][0-9]*$/u.test(result)) fail('Expected a VNDB visual novel ID', pointer);
  return result;
}
function integer(value: unknown, pointer: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    fail('Expected a positive dump integer', pointer);
  return value as number;
}
function nativeTimestamp(value: unknown, pointer: string): string {
  const result = text(value, pointer);
  if (
    result.trim() !== result ||
    !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/u.test(result)
  )
    fail('Invalid native modification timestamp', pointer);
  const day = result.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day ||
    (result.length > 10 &&
      (Number(result.slice(11, 13)) > 23 || Number(result.slice(14, 16)) > 59 || Number(result.slice(17, 19)) > 59))
  )
    fail('Invalid native modification timestamp', pointer);
  return result;
}
function rows(value: unknown, pointer: string, cap: number, optional = false): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail('Expected grouped dump rows', pointer);
  const array = value as unknown[];
  const length = Object.getOwnPropertyDescriptor(array, 'length')!.value as number;
  if (length > cap) fail('Dump row count exceeds source cap', pointer);
  const result = [];
  for (let i = 0; i < length; i++) {
    const child = field(array, String(i), `${pointer}/${i}`);
    if (child === undefined) fail('Sparse dump rows are unsupported', pointer);
    result.push(child);
  }
  return result;
}
function website(value: string, pointer: string): string {
  try {
    const host = new URL(value).hostname;
    // Public website citations only; these URLs are never fetched by this module.
    if (value.length > 1500 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host))
      fail('Invalid external website URL', pointer);
    return safeSourceUrl(value, [host]);
  } catch {
    return fail('Invalid external website URL', pointer);
  }
}

function latinLanguageTag(tag: string): string | null {
  const parts = tag.split('-');
  if (/^[A-Z][a-z]{3}$/u.test(parts[1] ?? '')) parts[1] = 'Latn';
  else parts.splice(1, 0, 'Latn');
  return canonicalLanguageTag(parts.join('-'));
}

/**
 * Projection of decoded dump tables, not a live API response. Schema authority:
 * https://g.blicky.net/vndb.git/tree/sql/schema.sql and https://vndb.org/d14.
 * Allowlist: vn.id/olang/c_average/c_votecount; entry_meta.id/revision/lastmod;
 * vn_titles.id/lang/official/title/latin;
 * vn_extlinks.id/link; extlinks.id/site/value. All other fields/tables are untouched.
 * https://vndb.org/d17#4 distinguishes ODbL database and DbCL contents licensing.
 * Neither licenses description/image republication; no creative content is projected.
 * The byte cap applies to this allowed projection, never to ignored private pollution.
 */
function project(input: ConversionInput): NormalizedRecord {
  const record = row(input.record, '/record');
  const vn = row(field(record, 'vn', '/vn'), '/vn');
  const id = nativeId(field(vn, 'id', '/vn/id'), '/vn/id');
  if (input.external_id !== id) fail('Source envelope ID does not match vn.id', '/external_id');
  const olangValue = field(vn, 'olang', '/vn/olang');
  const projectedVn: NormalizedRecord['vn'] = { id };
  if (olangValue !== undefined) projectedVn.olang = text(olangValue, '/vn/olang');
  const voteCount = field(vn, 'c_votecount', '/vn/c_votecount');
  const average = field(vn, 'c_average', '/vn/c_average');
  if ((voteCount === undefined) !== (average === undefined))
    fail('VNDB source statistic fields must be supplied together', '/vn');
  if (voteCount !== undefined && average !== undefined) {
    if (typeof voteCount !== 'number' || !Number.isSafeInteger(voteCount) || voteCount < 0 || voteCount > 2_147_483_647)
      fail('Invalid source vote count', '/vn/c_votecount');
    if (
      average !== null &&
      (typeof average !== 'number' || !Number.isSafeInteger(average) || average < 0 || average > 1000)
    )
      fail('Invalid source average', '/vn/c_average');
    projectedVn.c_votecount = voteCount as number;
    projectedVn.c_average = average as number | null;
  }
  const meta = row(field(record, 'entry_meta', '/entry_meta'), '/entry_meta');
  if (nativeId(field(meta, 'id', '/entry_meta/id'), '/entry_meta/id') !== id)
    fail('entry_meta ID does not match vn.id', '/entry_meta/id');
  const revision = integer(field(meta, 'revision', '/entry_meta/revision'), '/entry_meta/revision');
  if (input.record_revision !== String(revision))
    fail('Source envelope revision does not match entry_meta', '/record_revision');
  const projectedMeta: NormalizedRecord['entry_meta'] = { id, revision };
  const lastmod = field(meta, 'lastmod', '/entry_meta/lastmod');
  if (lastmod !== undefined) projectedMeta.lastmod = nativeTimestamp(lastmod, '/entry_meta/lastmod');
  const titles = rows(field(record, 'vn_titles', '/vn_titles'), '/vn_titles', vndbLimits.maxTitles).map((value, i) => {
    const p = `/vn_titles/${i}`;
    const entry = row(value, p);
    if (nativeId(field(entry, 'id', `${p}/id`), `${p}/id`) !== id) fail('Title ID does not match vn.id', `${p}/id`);
    const rawLanguage = text(field(entry, 'lang', `${p}/lang`), `${p}/lang`);
    const lang = canonicalLanguageTag(rawLanguage);
    if (lang === null) throw new ConversionError('Invalid title language', `${p}/lang`);
    const official = field(entry, 'official', `${p}/official`);
    if (typeof official !== 'boolean') fail('Expected title official boolean', `${p}/official`);
    const title = titleText(field(entry, 'title', `${p}/title`), `${p}/title`);
    const latin = field(entry, 'latin', `${p}/latin`);
    return {
      id,
      lang,
      official: official as boolean,
      title,
      latin: latin === null ? null : titleText(latin, `${p}/latin`),
    };
  });
  if (!titles.length) fail('No source title for bootstrap', '/vn_titles');
  const links = rows(field(record, 'vn_extlinks', '/vn_extlinks'), '/vn_extlinks', vndbLimits.maxLinks, true).map(
    (value, i) => {
      const p = `/vn_extlinks/${i}`;
      const entry = row(value, p);
      if (nativeId(field(entry, 'id', `${p}/id`), `${p}/id`) !== id)
        fail('External link child ID does not match vn.id', `${p}/id`);
      return { id, link: integer(field(entry, 'link', `${p}/link`), `${p}/link`) };
    },
  );
  const external = rows(field(record, 'extlinks', '/extlinks'), '/extlinks', vndbLimits.maxLinks, true).map(
    (value, i) => {
      const p = `/extlinks/${i}`;
      const entry = row(value, p);
      const key = integer(field(entry, 'id', `${p}/id`), `${p}/id`);
      const site = text(field(entry, 'site', `${p}/site`), `${p}/site`);
      const valueText = text(field(entry, 'value', `${p}/value`), `${p}/value`);
      return { id: key, site, value: site === 'website' ? website(valueText, `${p}/value`) : valueText };
    },
  );
  const byId = new Set(external.map((entry) => entry.id));
  const used = new Set(links.map((entry) => entry.link));
  if (
    byId.size !== external.length ||
    used.size !== links.length ||
    used.size !== byId.size ||
    links.some((link) => !byId.has(link.link))
  )
    fail('External link group has mismatched or duplicate IDs', '/vn_extlinks');
  const normalized = {
    vn: projectedVn,
    entry_meta: projectedMeta,
    vn_titles: titles,
    vn_extlinks: links,
    extlinks: external,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > vndbLimits.recordBytes)
    fail('Allowed dump projection exceeds 64 KiB', '/record');
  return normalized;
}

/** Pure two-phase conversion. Caller-owned resolution never changes the source digest. */
export function convertVndb(
  input: ConversionInput,
  context: ConversionContext = {},
  options: VndbOptions = {},
): VndbConversion {
  try {
    const normalizedRecord = project(input);
    const id = normalizedRecord.vn.id;
    const revision = String(normalizedRecord.entry_meta.revision);
    const digest = sourceDigest(normalizedRecord);
    const registration = options.converterRevision ?? converter_revision;
    const sourceId = context.source === undefined ? 'vndb' : context.source;
    const source = sourceEnvelope(
      { source: sourceId, external_id: id, record_revision: revision, converter_revision: registration, digest },
      'facts',
    );
    if (
      context.subjectId !== undefined &&
      (typeof context.subjectId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(context.subjectId))
    )
      fail('Expected a resolved subject UUID', '/context/subjectId');
    const reference: BatchReference = {
      parts: [
        { property: { id: 'wdt:P3180' }, value: { type: 'value', content: id } },
        { property: { id: 'schema:url' }, value: { type: 'value', content: `https://vndb.org/${id}.${revision}` } },
        { property: { id: 'schema:version' }, value: { type: 'value', content: revision } },
      ],
    };
    if (normalizedRecord.entry_meta.lastmod !== undefined) {
      reference.parts.push({
        property: { id: 'schema:dateModified' },
        value: {
          type: 'value',
          content: {
            // Cite the native calendar day, without shifting it through the timestamp's offset.
            time: `+${normalizedRecord.entry_meta.lastmod.slice(0, 10)}T00:00:00Z`,
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      });
    }
    const statement = (property: string, content: unknown): BatchStatement => ({
      property: { id: property },
      value: { type: 'value', content },
      references: [reference],
    });
    const titles: { language: string; text: string; official: boolean }[] = [];
    for (const title of normalizedRecord.vn_titles) {
      titles.push({ language: title.lang, text: title.title, official: title.official });
      if (title.latin !== null) {
        const language = latinLanguageTag(title.lang);
        if (language === null) throw new ConversionError('Invalid title language', '/vn_titles');
        titles.push({ language, text: title.latin, official: false });
      }
    }
    if (titles.length > vndbLimits.maxTitleCandidates) fail('Title candidates exceed source cap', '/vn_titles');
    // Prefer official titles for initial labels; all titles remain actual candidates.
    titles.sort(
      (a, b) => Number(b.official) - Number(a.official) || compare(a.language, b.language) || compare(a.text, b.text),
    );
    const uniqueTitles = new Map<string, { language: string; text: string }>();
    const labels: Record<string, string> = Object.create(null);
    for (const title of titles) {
      labels[title.language] ??= title.text;
      uniqueTitles.set(JSON.stringify([title.language, title.text]), { language: title.language, text: title.text });
    }
    const aliases: Record<string, string[]> = Object.create(null);
    for (const title of uniqueTitles.values()) {
      if (labels[title.language] !== title.text) (aliases[title.language] ??= []).push(title.text);
    }
    const statements = [
      statement('wdt:P3180', id),
      ...Array.from(uniqueTitles.values(), (title) => statement('schema:name', title)),
    ];
    const diagnostics: ConversionDiagnostic[] = [];
    if (normalizedRecord.vn.olang !== undefined) {
      const language = inLanguageTag(normalizedRecord.vn.olang);
      if (language === null) {
        diagnostics.push({
          pointer: '/vn/olang',
          code: 'Original language has no supported canonical language tag; omitted from proposals',
        });
      } else statements.push(statement('schema:inLanguage', language));
    }
    for (const [i, link] of normalizedRecord.extlinks.entries()) {
      if (link.site === 'website') statements.push(statement('schema:url', link.value));
      else
        diagnostics.push({
          pointer: `/extlinks/${i}/site`,
          code: 'Unsupported external link site; retained as source metadata only',
        });
    }
    const key = (operation: string, group: string): string =>
      commandKey([sourceId, id, revision, digest, registration, 'facts', operation, context.subjectId ?? '', group]);
    const proposals: BatchCommand[] =
      context.subjectId === undefined
        ? [
            {
              op: 'create',
              source,
              key: key('create', 'bootstrap'),
              subject: {
                type: 'wd:Q689445',
                labels,
                descriptions: {},
                ...(Object.keys(aliases).length ? { aliases } : {}),
              },
            },
          ]
        : statements.map((entry, i) => ({
            op: 'propose',
            source,
            key: key('propose', String(i)),
            subject: context.subjectId!,
            statement: entry,
          }));
    if (proposals.length > vndbLimits.maxCommands) fail('Command count exceeds source cap', '/proposals');
    if (checkBatchWrite({ commands: proposals }).length)
      fail('Generated commands failed portable validation', '/proposals');
    return {
      source: 'vndb',
      external_id: id,
      record_revision: revision,
      converter_revision: registration,
      digest,
      normalizedRecord,
      proposals,
      diagnostics,
      assets: [],
      sourceMetadata: { databaseLicense: 'ODbL-1.0', contentsLicense: 'LicenseRef-DbCL-1.0', attribution: 'VNDB' },
    };
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    // Never disclose a body, accessor error, URL credentials or private input in diagnostics.
    throw new ConversionError('Invalid VNDB conversion input or registration', '/record');
  }
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
