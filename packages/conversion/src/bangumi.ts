import { types as utilTypes } from 'node:util';
import {
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { ConversionError, type ConversionInput, type ConvertedRecord } from './index.ts';
import {
  bangumiPublicationTime,
  isAdmittedBangumiType,
  selectBangumiProfile,
} from './bangumi-subject-profile.ts';
import {
  checkCoverIntent,
  bangumiPublicTagScheme,
  reviewedReferenceKey,
  commandKey,
  safeSourceUrl,
  sourceDigest,
  sourceEnvelope,
  textDocument,
  type ConversionContext,
} from './support.ts';

export const converter_revision = 'bangumi@5';

// Only these source fields are visited. Unknown/private subtrees are never traversed.
// Projection bytes <=64 KiB; tags <=64 x 200 characters; titles <=500 characters;
// summary <=32 KiB INCLUDING the Text snapshot; infobox <=64 KiB. No truncation.
// Twelve projected top-level fields; at most eight commands, one cover intent,
// and one citation envelope per statement with at most two URL parts.
type IgnoredRecord = { id: number; type: 3 | 6 };
type NormalizedRecord = {
  id: number;
  type: 1 | 2 | 3 | 4 | 6;
  name: string;
  name_cn?: string;
  summary?: string;
  images?: { large: string };
  tags?: { name: string }[];
  meta_tags?: string[];
  platform?: string;
  infobox?: string;
  nsfw?: boolean;
  date?: string;
};
type DeferredCover = Omit<MediaImportRequest, 'containerId'>;
export type BangumiConversion = ConvertedRecord<BatchCommand> & {
  outcome: 'converted' | 'ignored';
  record_revision: string;
  digest: string;
  /** Sanitized source payload, suitable for a later pure target-binding call. */
  normalizedRecord: NormalizedRecord | IgnoredRecord;
  /** Deferred assets have no container; only mediaImportIntents are executable. */
  coverAssets: DeferredCover[];
  mediaImportIntents: MediaImportRequest[];
  sourceMetadata: {
    recordUrl: string;
    summary: { language: string; takedownEligible: true };
    cover: { role: 'cover'; creditLine: string; takedownEligible: true };
  };
};

function invalid(pointer: string, code = 'invalid_record'): never {
  throw new ConversionError(code, pointer);
}
function object(value: unknown, pointer: string): object {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) invalid(pointer);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(pointer);
  return value;
}
// Data descriptors prevent source getters/toJSON from becoming conversion policy.
function own(value: object, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalid(pointer);
  return descriptor.value;
}
function string(value: unknown, pointer: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || (!empty && !value.trim()))
    invalid(pointer);
  return value;
}
function normalize(input: ConversionInput): NormalizedRecord | IgnoredRecord {
  const raw = object(input.record, '');
  const get = (key: string) => own(raw, key, `/${key}`);
  const id = get('id');
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || String(id) !== input.external_id)
    invalid('/id', 'invalid_identifier');
  const type = get('type');
  if (typeof type !== 'number' || !isAdmittedBangumiType(type)) invalid('/type', 'unsupported_type');
  // Prior ignored 3/6 projections stored only identity. Missing name keeps that seam.
  if ((type === 3 || type === 6) && Object.getOwnPropertyDescriptor(raw, 'name') === undefined) return { id, type };
  const record: NormalizedRecord = { id, type, name: string(get('name'), '/name', 500) };
  const chinese = get('name_cn');
  if (chinese !== undefined) record.name_cn = string(chinese, '/name_cn', 500, true);
  const summary = get('summary');
  if (summary !== undefined) record.summary = string(summary, '/summary', 32_768, true);
  const images = get('images');
  if (images !== undefined) {
    const large = own(object(images, '/images'), 'large', '/images/large');
    if (large !== undefined) {
      try {
        record.images = { large: safeSourceUrl(large, ['lain.bgm.tv']) };
      } catch {
        invalid('/images/large', 'invalid_cover_url');
      }
    }
  }
  const tags = get('tags');
  if (tags !== undefined) {
    if (utilTypes.isProxy(tags) || !Array.isArray(tags) || Object.getPrototypeOf(tags) !== Array.prototype)
      invalid('/tags');
    const length: unknown = Object.getOwnPropertyDescriptor(tags, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > 64)
      invalid('/tags', 'invalid_record_tag_limit');
    record.tags = [];
    for (let i = 0; i < length; i++) {
      const tag = object(own(tags, String(i), `/tags/${i}`), `/tags/${i}`);
      record.tags.push({ name: string(own(tag, 'name', `/tags/${i}/name`), `/tags/${i}/name`, 200) });
    }
  }
  const metaTags = get('meta_tags');
  if (metaTags !== undefined) {
    if (utilTypes.isProxy(metaTags) || !Array.isArray(metaTags) || Object.getPrototypeOf(metaTags) !== Array.prototype)
      invalid('/meta_tags');
    const length: unknown = Object.getOwnPropertyDescriptor(metaTags, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > 64)
      invalid('/meta_tags', 'invalid_record_tag_limit');
    record.meta_tags = [];
    for (let i = 0; i < length; i++)
      record.meta_tags.push(string(own(metaTags, String(i), `/meta_tags/${i}`), `/meta_tags/${i}`, 200));
  }
  for (const key of ['platform', 'infobox', 'date'] as const) {
    const value = get(key);
    if (value !== undefined) record[key] = string(value, `/${key}`, key === 'infobox' ? 65_536 : 500, true);
  }
  const nsfw = get('nsfw');
  if (nsfw !== undefined) {
    if (typeof nsfw !== 'boolean') invalid('/nsfw');
    record.nsfw = nsfw;
  }
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 65_536) invalid('', 'invalid_record_byte_limit');
  return record;
}

function retainedFieldDiagnostics(record: NormalizedRecord): { pointer: string; code: string }[] {
  const citedDate = (record.type === 3 || record.type === 6) && !!record.date?.trim() && !!bangumiPublicationTime(record.date.trim());
  return (['tags', 'platform', 'infobox', 'nsfw', 'date'] as const)
    .filter((field) => record[field] !== undefined)
    .filter((field) => field !== 'date' || !citedDate)
    .map((field) => ({
      pointer: `/${field}`,
      code:
        field === 'date'
          ? 'unsupported_date_mapping'
          : field === 'platform' && (record.type === 3 || record.type === 6)
            ? 'source_platform_selects_profile'
            : field === 'infobox'
              ? 'unsupported_infobox_mapping'
              : `catalogue_has_no_${field}_property`,
    }));
}

/** Pure conversion: one bootstrap, or candidates bound to an actual resolved subject. */
export function convertBangumi(
  input: ConversionInput,
  context: ConversionContext = {},
  options: { readonly converterRevision?: string } = {},
): BangumiConversion {
  try {
    return convert(input, context, options.converterRevision ?? converter_revision);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    // Never expose a source scalar (or a hostile thrown value) through diagnostics.
    invalid('', 'invalid_record_or_context');
  }
}

function convert(input: ConversionInput, context: ConversionContext, revision: string): BangumiConversion {
  const record = normalize(input);
  const digest = sourceDigest(record);
  const sourceId = context.source === undefined ? 'bangumi' : context.source;
  const metadata = {
    source: sourceId,
    external_id: input.external_id,
    record_revision: input.record_revision ?? 'unversioned',
    converter_revision: revision,
    digest,
  };
  const envelope = (group: FieldGroup) => sourceEnvelope(metadata, group);
  const recordUrl = `https://bgm.tv/subject/${input.external_id}`;
  const sourceMetadata: BangumiConversion['sourceMetadata'] = {
    recordUrl,
    summary: { language: 'und', takedownEligible: true },
    cover: { role: 'cover', creditLine: '(c) rights holder via Bangumi', takedownEligible: true },
  };
  if (!('name' in record)) {
    // No command will validate the envelope on this path; apply the same bounds.
    envelope('facts');
    return {
      ...metadata,
      source: 'bangumi',
      outcome: 'ignored',
      normalizedRecord: record,
      proposals: [],
      diagnostics: [{ pointer: '/type', code: 'ignored_identity_only_projection' }],
      coverAssets: [],
      mediaImportIntents: [],
      sourceMetadata,
    };
  }
  const profile = selectBangumiProfile(record);
  if (profile.outcome === 'unknown_live_action_platform') {
    envelope('facts');
    return {
      ...metadata,
      source: 'bangumi',
      outcome: 'ignored',
      normalizedRecord: record,
      proposals: [],
      diagnostics: [
        {
          pointer: '/platform',
          code: 'unknown_live_action_platform',
        },
      ],
      coverAssets: [],
      mediaImportIntents: [],
      sourceMetadata,
    };
  }
  const references = (urls: string[] = [recordUrl]): BatchReference[] => [
    {
      parts: urls.map((url) => ({ property: { id: 'schema:url' }, value: { type: 'value', content: url } })),
    },
  ];
  const key = (field: string, group: FieldGroup) =>
    commandKey([
      sourceId,
      input.external_id,
      metadata.record_revision,
      digest,
      revision,
      group,
      field,
      context.subjectId ?? 'bootstrap',
    ]);
  const fact = (property: string, content: unknown): BatchStatement => ({
    property: { id: property },
    value: { type: 'value', content },
    references: references(),
  });
  // Bangumi does not declare the original title/summary language. Preserve that
  // uncertainty rather than mislabelling all works Japanese. name_cn is Chinese.
  const titles = [fact('schema:name', { language: 'und', text: record.name })];
  if (record.name_cn?.trim()) titles.push(fact('schema:name', { language: 'zh', text: record.name_cn }));
  const facts = [fact('wdt:P5732', input.external_id), ...titles];
  if (record.meta_tags?.includes('后宫')) {
    const reference = reviewedReferenceKey(bangumiPublicTagScheme, '后宫');
    const dictionary = context.resolvedReferences;
    if (dictionary && (typeof dictionary !== 'object' || utilTypes.isProxy(dictionary)))
      invalid('', 'invalid_reference_context');
    const descriptor = dictionary ? Object.getOwnPropertyDescriptor(dictionary, reference) : undefined;
    if (descriptor && (!('value' in descriptor) || !descriptor.enumerable)) invalid('', 'invalid_reference_context');
    const concept: unknown = descriptor?.value;
    if (concept !== undefined) {
      if (
        typeof concept !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(concept)
      )
        invalid('', 'invalid_reference_context');
      facts.push({
        ...fact('schema:keywords', concept),
        qualifiers: [
          { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '0', unit: '1' } } },
        ],
      });
    }
  }
  let document;
  if (record.summary) {
    try {
      document = textDocument(record.summary);
    } catch {
      invalid('/summary', 'invalid_record_summary_document_limit');
    }
  }
  const proposals: BatchCommand[] = [];
  const propose = (
    statement: BatchStatement,
    group: FieldGroup,
    field: string,
  ): Extract<BatchCommand, { op: 'propose' }> => ({
    op: 'propose',
    key: key(field, group),
    source: envelope(group),
    subject: context.subjectId!,
    statement,
  });
  if (context.subjectId === undefined) {
    const labels: Record<string, string> = { und: record.name };
    if (record.name_cn?.trim()) labels.zh = record.name_cn;
    proposals.push({
      op: 'create',
      key: key('bootstrap', 'facts'),
      source: envelope('facts'),
      subject: { type: profile.type, labels },
    });
  } else {
    for (const [index, statement] of facts.entries()) proposals.push(propose(statement, 'facts', `fact:${index}`));
    if (record.type === 3 || record.type === 6) {
      const published = record.date?.trim() ? bangumiPublicationTime(record.date.trim()) : undefined;
      if (published) proposals.push(propose(fact('schema:datePublished', published), 'facts', 'date'));
    }
    if (document) {
      proposals.push({
        ...propose(fact('schema:abstract', { language: 'und', document }), 'summary', 'summary'),
        rights: {
          license: 'CC-BY-SA-3.0',
          obligations: ['cc:Attribution', 'cc:ShareAlike'],
          attribution: `Bangumi contributors (${recordUrl})`,
        },
      });
    }
  }
  const coverAssets: DeferredCover[] = [];
  const mediaImportIntents: MediaImportRequest[] = [];
  if (record.images) {
    const sourceUrl = record.images.large;
    const asset: DeferredCover = {
      sourceUrl,
      credit: {
        rightsHolder: '(c) rights holder',
        via: { name: 'Bangumi', url: recordUrl },
        license: 'LicenseRef-unknown',
        obligations: [],
      },
      provenance: { ...envelope('cover'), field_group: 'cover', references: references([recordUrl, sourceUrl]) },
    };
    coverAssets.push(asset);
    if (context.subjectId !== undefined) {
      const intent = { containerId: context.subjectId, ...asset };
      if ((typeof context.subjectId === 'string' ? checkCoverIntent : checkMediaImportRequest)(intent).length)
        invalid('', 'invalid_media_import_context');
      mediaImportIntents.push(intent);
      const media = context.mediaIds?.[sourceUrl];
      if (media !== undefined)
        proposals.push(
          propose(
            {
              property: { id: 'schema:image' },
              value: { type: 'value', content: media },
              references: asset.provenance.references,
            },
            'cover',
            `cover:${media}`,
          ),
        );
    }
  }
  if (checkBatchWrite({ commands: proposals }).length) invalid('', 'invalid_record_proposals');
  return {
    ...metadata,
    source: 'bangumi',
    outcome: 'converted',
    proposals,
    digest,
    normalizedRecord: record,
    // These source-only fields have no declared mapping in this converter. Their
    // values are retained only in normalizedRecord, never invented catalogue slots.
    diagnostics: retainedFieldDiagnostics(record),
    coverAssets,
    mediaImportIntents,
    sourceMetadata,
  };
}
