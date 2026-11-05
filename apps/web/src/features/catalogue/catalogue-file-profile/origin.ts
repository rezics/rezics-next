import { subjectVisitReturn } from '../../pages/subject-visit-navigation';
import {
  CATALOGUE_FILE_READER_ANCHOR,
  catalogueFileSourceId,
  fileEvidenceAt,
  fileReaderRealm,
  fileReaderSlug,
} from '../catalogue-file-reader/navigation';
import { fileScalarFields } from './model';
import type { CatalogueFileRead } from './read';
import { subjectHref } from '../../../subject/subject-href';

export const CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT = 2048;

export type CatalogueFileCorrectionSelection = {
  property: string;
  statement: string;
  holder: string;
};

/** Public navigation intent only. It contains no native advice, credentials or command operands. */
export type CatalogueFileCorrectionOrigin = {
  subject: string;
  type: string;
  context: string;
  definition: string;
  realm?: string;
  returnHref: string;
  selection?: CatalogueFileCorrectionSelection;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const definitionToken = /^[A-Za-z0-9:_./-]{1,128}$/u;
const typeToken = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const propertyToken = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const encoder = new TextEncoder();

function base64UrlEncode(value: string): string {
  let binary = '';
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT ||
    encoder.encode(value).byteLength > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (base64UrlEncode(decoded) !== value) return;
    return decoded;
  } catch {
    return;
  }
}

function subjectReturn(value: unknown, locale: string, sourceId?: string): string | undefined {
  if (typeof value !== 'string') return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const subject = new RegExp(`^/${locale}/subjects/(${uuid.source.slice(1, -1)})/[^/?#]+$`, 'i').exec(url.pathname);
  if (
    url.origin !== 'https://rezics.invalid' ||
    !subject ||
    (sourceId && subject[1]!.toLowerCase() !== sourceId.toLowerCase()) ||
    url.searchParams.has('via')
  )
    return;
  return accepted;
}

/** Accept only a current same-locale Subject address or the reader's existing validated evidence receipt. */
export function catalogueFileCorrectionReturnHref(
  value: unknown,
  locale: string,
  sourceId?: string,
  context?: string,
  definition?: string,
): string | undefined {
  const accepted = subjectReturn(value, locale, sourceId);
  if (accepted) return accepted;
  if (typeof value !== 'string' || value.length > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT) return;
  let url: URL;
  try {
    url = new URL(value, 'https://rezics.invalid');
  } catch {
    return;
  }
  if (url.origin !== 'https://rezics.invalid') return;
  const parts = url.pathname.split('/');
  const id = catalogueFileSourceId(parts[3]);
  if (
    !id ||
    (sourceId && id.toLowerCase() !== sourceId.toLowerCase()) ||
    !fileReaderSlug(value, id, locale) ||
    parts.length !== 5 ||
    [...url.searchParams.keys()].some((key) => key !== 'realm') ||
    url.searchParams.getAll('realm').length > 1
  )
    return;
  const realmValue = url.searchParams.get('realm');
  const realm = realmValue === null ? undefined : fileReaderRealm(value, id, locale);
  if (realmValue !== null && !realm) return;
  const evidence = fileEvidenceAt(value, locale);
  if (
    (url.hash !== `#${CATALOGUE_FILE_READER_ANCHOR}` && !evidence) ||
    (evidence &&
      (evidence.source.toLowerCase() !== id.toLowerCase() ||
        (context && evidence.context.toLowerCase() !== context.toLowerCase()) ||
        (definition && evidence.definition !== definition) ||
        (evidence.realm ?? undefined) !== realm))
  )
    return;
  return `${url.pathname}${url.search}${url.hash}`;
}

function validSelection(value: unknown): value is CatalogueFileCorrectionSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return (
    Object.keys(selection).length === 3 &&
    Object.keys(selection).every((key) => ['property', 'statement', 'holder'].includes(key)) &&
    typeof selection.property === 'string' &&
    propertyToken.test(selection.property) &&
    typeof selection.statement === 'string' &&
    uuid.test(selection.statement) &&
    typeof selection.holder === 'string' &&
    uuid.test(selection.holder)
  );
}

function validOrigin(
  value: unknown,
  locale: string,
  sourceId?: string,
  subjectId?: string,
  typeId?: string,
): CatalogueFileCorrectionOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  const allowed = new Set(['subject', 'type', 'context', 'definition', 'realm', 'returnHref', 'selection']);
  if (Object.keys(origin).some((key) => !allowed.has(key))) return;
  if (
    typeof origin.subject !== 'string' ||
    !uuid.test(origin.subject) ||
    (subjectId && origin.subject.toLowerCase() !== subjectId.toLowerCase()) ||
    typeof origin.type !== 'string' ||
    !typeToken.test(origin.type) ||
    (typeId && origin.type !== typeId) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    typeof origin.definition !== 'string' ||
    !definitionToken.test(origin.definition) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm))) ||
    (origin.selection !== undefined && !validSelection(origin.selection))
  )
    return;
  const returnHref = catalogueFileCorrectionReturnHref(
    origin.returnHref,
    locale,
    sourceId,
    origin.context,
    origin.definition,
  );
  if (!returnHref) return;
  return {
    subject: origin.subject.toLowerCase(),
    type: origin.type,
    context: origin.context.toLowerCase(),
    definition: origin.definition,
    ...(typeof origin.realm === 'string' ? { realm: origin.realm.toLowerCase() } : {}),
    returnHref,
    ...(validSelection(origin.selection)
      ? {
          selection: {
            property: origin.selection.property,
            statement: origin.selection.statement.toLowerCase(),
            holder: origin.selection.holder.toLowerCase(),
          },
        }
      : {}),
  };
}

/** Serialize a finite public intent as a bounded base64url query value. */
export function catalogueFileCorrectionOriginParam(
  value: CatalogueFileCorrectionOrigin,
  locale: string,
  sourceId?: string,
  subjectId?: string,
  typeId?: string,
): string | undefined {
  const origin = validOrigin(value, locale, sourceId, subjectId, typeId);
  if (!origin) return;
  const bytes = encoder.encode(JSON.stringify(origin));
  if (bytes.byteLength > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT) return;
  const encoded = base64UrlEncode(new TextDecoder().decode(bytes));
  if (
    encoded.length > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT ||
    encoder.encode(encoded).byteLength > CATALOGUE_FILE_CORRECTION_ORIGIN_LIMIT
  )
    return;
  return encoded;
}

export type ParsedCatalogueFileCorrectionOrigin =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; origin: CatalogueFileCorrectionOrigin };

/** HTTP query boundary: cap the encoded descriptor before decoding or parsing its JSON body. */
export function parseCatalogueFileCorrectionOrigin(
  value: unknown,
  locale: string,
  sourceId?: string,
  hasSeparateReturn = false,
): ParsedCatalogueFileCorrectionOrigin {
  if (value === undefined) return { kind: 'absent' };
  if (hasSeparateReturn) return { kind: 'invalid' };
  const decoded = base64UrlDecode(value as string);
  if (!decoded) return { kind: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(decoded);
    const origin = validOrigin(parsed, locale, sourceId);
    return origin ? { kind: 'valid', origin } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** A locator only reopens candidate review when its exact current holder and statement remain admitted. */
export function admittedCatalogueFileSelection(
  read: Extract<CatalogueFileRead, { ok: true }>,
  origin: CatalogueFileCorrectionOrigin,
): { property: string; candidate: string } | undefined {
  const selection = origin.selection;
  const subject = read.public.subject;
  if (
    !selection ||
    read.profile === 'unreleased' ||
    origin.subject.toLowerCase() !== subject.id.toLowerCase() ||
    origin.type !== subject.type ||
    origin.context.toLowerCase() !== subject.context.toLowerCase() ||
    origin.definition !== read.digest ||
    selection.holder.toLowerCase() !== subject.id.toLowerCase() ||
    !fileScalarFields(read.release, subject.type).includes(selection.property) ||
    !(subject.statements[selection.property] ?? []).some(
      (statement) => statement.id.toLowerCase() === selection.statement.toLowerCase(),
    )
  )
    return;
  return { property: selection.property, candidate: selection.statement };
}

export function catalogueFileCorrectionOriginExpired(
  read: Extract<CatalogueFileRead, { ok: true }>,
  origin: CatalogueFileCorrectionOrigin,
): boolean {
  return (
    read.profile === 'unreleased' ||
    origin.subject.toLowerCase() !== read.public.subject.id.toLowerCase() ||
    origin.type !== read.public.subject.type ||
    origin.context.toLowerCase() !== read.public.subject.context.toLowerCase() ||
    origin.definition !== read.digest ||
    (!!origin.selection && !admittedCatalogueFileSelection(read, origin))
  );
}

/** Start a clean Global visit while preserving at most the immediate public return and source-id seam. */
export function catalogueFileGlobalHref(
  id: string,
  locale: string,
  sourceId?: string,
  returnHref?: string,
): string {
  const href = `${subjectHref({ id, label: '' }, locale).href}/file`;
  const search = new URLSearchParams();
  const source = catalogueFileSourceId(sourceId);
  const returned = returnHref ? catalogueFileCorrectionReturnHref(returnHref, locale, source) : undefined;
  if (source) search.set('fileSource', source);
  if (returned) search.set('via', returned);
  return `${href}${search.size ? `?${search}` : ''}`;
}
