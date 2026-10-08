import { checkDocument, fromPlainText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { editorDocument, hasBodyContent } from '../document-editor/body.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const iri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const variant = /^urn:rezics:variant:[0-9a-f-]{36}$/;

/** The exact Content revision a publish binds. The epoch is the draft's owner position, not a later one. */
export interface DraftBasis {
  revisionId: string;
  byteDigest: string;
  contentEpoch: string;
}

export interface ContentLanguage {
  kind: 'tag';
  tag: string;
  originalTag: string;
}

export type AuthoringFailure = 'unavailable' | 'denied' | 'sign-in' | 'invalid' | 'conflict' | 'missing';

export type Notice =
  | { kind: 'idle' }
  | { kind: 'saved'; replayed: boolean }
  | { kind: 'published'; replayed: boolean }
  | { kind: 'stale'; currentHead: string | null }
  | { kind: 'publish-stale' }
  | { kind: 'loaded' }
  | { kind: AuthoringFailure };

export interface EditorState {
  /** Serialized document the author is writing. A stale refusal never replaces it. */
  value: string;
  /** The last snapshot the server holds, or null when it has no draft yet. */
  savedValue: string | null;
  /** Content draft head the next save names. Null only for the first save. */
  expectedHead: string | null;
  basis: DraftBasis | null;
  /** Zone configuration head. A publish names this as its expected head. */
  zoneHead: string;
  /** Current navigation Structure revision. Routes and navigation must name this same revision. */
  navigationRevision: string;
  publishedRevisionId: string | null;
  variantId: string;
  language: ContentLanguage;
  direction: 'ltr' | 'rtl' | 'none';
  embeds?: string[];
  notice: Notice;
}

export interface DraftChoice {
  resourceId: string;
  variantId: string;
  language: ContentLanguage;
  direction: 'ltr' | 'rtl' | 'none';
  expectedHead: string | null;
  document: DocumentSnapshot;
  actingSubject: string;
  embeds?: string[];
  /** Editor text this choice captured, so a keystroke during the save stays in the field. */
  captured: string;
  /** Canonical text of `document`, which becomes the saved snapshot when this choice lands. */
  savedValue: string;
}

export interface DraftWire {
  profile: 'content-text-v1';
  resourceId: string;
  variantId: string;
  language: ContentLanguage;
  direction: 'ltr' | 'rtl' | 'none';
  expectedHead: string | null;
  document: DocumentSnapshot;
  actingSubject: string;
  embeds?: string[];
}

export interface PublicationChoice {
  /** Same Structure revision as `navigationRevision`. The publication refuses a pair that differs. */
  routesRevision: string;
  navigationRevision: string;
  zoneHead: string;
  page: string;
  variantId: string;
  revisionId: string;
  byteDigest: string;
  contentEpoch: string;
}

export interface PublicationWire {
  routesRevision: string;
  navigationRevision: string;
  pages: [{ page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }];
  expectedHead: string;
  actingSubject: string;
}

export type EditorEvent =
  | { type: 'edit'; value: string }
  | { type: 'saved'; captured: string; savedValue: string; basis: DraftBasis; replayed: boolean }
  | { type: 'stale'; currentHead: string | null }
  | { type: 'retarget'; currentHead: string }
  | { type: 'loaded'; value: string; expectedHead: string | null; basis: DraftBasis | null; embeds?: string[];
      variantId: string; language: ContentLanguage; direction: 'ltr' | 'rtl' | 'none';
      zoneHead: string; publishedRevisionId: string | null }
  | { type: 'published'; zoneHead: string; replayed: boolean }
  | { type: 'publish-stale' }
  | { type: 'heads'; zoneHead: string; navigationRevision: string }
  | { type: 'failed'; failure: AuthoringFailure };

/** An unsaved first draft counts once it has text. After a save, only a difference from that snapshot is unsaved. */
export function isDirty(state: EditorState): boolean {
  if (state.savedValue === null) return hasBodyContent(state.value);
  return state.value !== state.savedValue;
}

/** Readers receive the saved snapshot, so a publish waits until the field matches it and the page has text. */
export function canPublish(state: EditorState): boolean {
  return Boolean(state.basis && state.savedValue !== null && !isDirty(state) && hasBodyContent(state.value));
}

export function publicationStatus(state: EditorState): 'private' | 'live' | 'behind' {
  if (!state.publishedRevisionId) return 'private';
  if (state.basis && state.basis.revisionId === state.publishedRevisionId && !isDirty(state)) return 'live';
  return 'behind';
}

export function reduceEditor(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case 'edit':
      return state.value === event.value ? state : {
        ...state,
        value: event.value,
        notice: clearsOnEdit(state.notice) ? { kind: 'idle' } : state.notice,
      };
    case 'saved':
      return {
        ...state,
        value: state.value === event.captured ? event.savedValue : state.value,
        savedValue: event.savedValue,
        expectedHead: event.basis.revisionId,
        basis: event.basis,
        notice: { kind: 'saved', replayed: event.replayed },
      };
    case 'stale':
      return { ...state, notice: { kind: 'stale', currentHead: event.currentHead } };
    case 'retarget':
      return { ...state, expectedHead: event.currentHead, notice: { kind: 'idle' } };
    case 'loaded':
      return {
        ...state,
        value: event.value,
        savedValue: event.basis ? event.value : null,
        expectedHead: event.expectedHead,
        basis: event.basis,
        embeds: event.embeds,
        variantId: event.variantId,
        language: event.language,
        direction: event.direction,
        zoneHead: event.zoneHead,
        publishedRevisionId: event.publishedRevisionId,
        notice: { kind: 'loaded' },
      };
    case 'published':
      return {
        ...state,
        publishedRevisionId: state.basis?.revisionId ?? state.publishedRevisionId,
        zoneHead: event.zoneHead,
        notice: { kind: 'published', replayed: event.replayed },
      };
    case 'publish-stale':
      return { ...state, notice: { kind: 'publish-stale' } };
    case 'heads':
      return {
        ...state,
        zoneHead: event.zoneHead,
        navigationRevision: event.navigationRevision,
        notice: state.notice.kind === 'publish-stale' ? { kind: 'idle' } : state.notice,
      };
    case 'failed':
      return { ...state, notice: { kind: event.failure } };
  }
}

/** A quiet confirmation leaves as soon as the text changes. A refusal stays until the author answers it. */
function clearsOnEdit(notice: Notice): boolean {
  return notice.kind === 'saved' || notice.kind === 'published' || notice.kind === 'loaded';
}

export function draftChoice(state: EditorState, resourceId: string, actingSubject: string): DraftChoice {
  const document = editorDocument(state.value);
  return {
    resourceId,
    variantId: state.variantId,
    language: state.language,
    direction: state.direction,
    expectedHead: state.expectedHead,
    document,
    actingSubject,
    ...(state.embeds ? { embeds: state.embeds } : {}),
    captured: state.value,
    savedValue: serializeDocument(document),
  };
}

export function draftWire(choice: DraftChoice): DraftWire {
  return {
    profile: 'content-text-v1',
    resourceId: choice.resourceId,
    variantId: choice.variantId,
    language: choice.language,
    direction: choice.direction,
    expectedHead: choice.expectedHead,
    document: choice.document,
    actingSubject: choice.actingSubject,
    ...(choice.embeds ? { embeds: choice.embeds } : {}),
  };
}

export function publicationChoice(state: EditorState, zoneIri: string): PublicationChoice | null {
  if (!canPublish(state) || !state.basis) return null;
  return {
    routesRevision: state.navigationRevision,
    navigationRevision: state.navigationRevision,
    zoneHead: state.zoneHead,
    page: zoneIri,
    variantId: state.variantId,
    revisionId: state.basis.revisionId,
    byteDigest: state.basis.byteDigest,
    contentEpoch: state.basis.contentEpoch,
  };
}

export function publicationWire(choice: PublicationChoice, actingSubject: string): PublicationWire {
  return {
    routesRevision: choice.navigationRevision,
    navigationRevision: choice.navigationRevision,
    pages: [{
      page: choice.page,
      variantId: choice.variantId,
      revisionId: choice.revisionId,
      byteDigest: choice.byteDigest,
      contentEpoch: choice.contentEpoch,
    }],
    expectedHead: choice.zoneHead,
    actingSubject,
  };
}

export function blankDocument(): string {
  return serializeDocument(fromPlainText('', 'blocks'));
}

export interface ZoneAuthoringModel {
  zoneId: string;
  zoneIri: string;
  name: string;
  editable: boolean;
  state: EditorState;
  document: DocumentSnapshot | null;
}

interface LoadedDraft {
  value: string;
  expectedHead: string | null;
  basis: DraftBasis | null;
  embeds?: string[];
  variantId: string;
  language: ContentLanguage;
  direction: 'ltr' | 'rtl' | 'none';
  zoneHead: string;
  navigationRevision: string;
  publishedRevisionId: string | null;
  editable: boolean;
  document: DocumentSnapshot | null;
}

/** The editor read, when it names a variant and both heads a later publish needs. */
export function authoringModel(showcase: unknown, zone: unknown, zoneId: string, fallbackName: string): ZoneAuthoringModel | null {
  const draft = loadedDraft(showcase, zone);
  if (!draft || !uuid.test(zoneId)) return null;
  const name = record(showcase)?.name;
  return {
    zoneId,
    zoneIri: `https://rezics.com/id/${zoneId}`,
    name: typeof name === 'string' && name.trim() ? name : fallbackName,
    editable: draft.editable,
    document: draft.document,
    state: {
      value: draft.value,
      savedValue: draft.basis ? draft.value : null,
      expectedHead: draft.expectedHead,
      basis: draft.basis,
      zoneHead: draft.zoneHead,
      navigationRevision: draft.navigationRevision,
      publishedRevisionId: draft.publishedRevisionId,
      variantId: draft.variantId,
      language: draft.language,
      direction: draft.direction,
      ...(draft.embeds ? { embeds: draft.embeds } : {}),
      notice: { kind: 'idle' },
    },
  };
}

/** A reload after a stale save. The author's text is replaced only because they asked. */
export function loadedDraft(showcase: unknown, zone: unknown): LoadedDraft | null {
  const row = record(showcase);
  const draft = record(row?.draft);
  const variantId = typeof draft?.variantId === 'string' ? draft.variantId : '';
  const zoneHead = ownerHead(zone) ?? (typeof row?.revision === 'string' && iri.test(row.revision) ? row.revision : '');
  const navigation = navigationOf(zone);
  if (!variant.test(variantId) || !iri.test(zoneHead) || !navigation) return null;
  const language = languageOf(draft?.language, typeof row?.language === 'string' ? row.language : 'und');
  const direction = directionOf(draft?.direction, row?.direction);
  const notes = draft?.notes !== undefined;
  const embeds = embedsOf(draft?.embeds);
  const document = checkDocument(draft?.document) ? draft.document : null;
  const revisionId = typeof draft?.revisionId === 'string' && uuid.test(draft.revisionId) ? draft.revisionId : null;
  const byteDigest = typeof draft?.byteDigest === 'string' && digest.test(draft.byteDigest) ? draft.byteDigest : null;
  const epoch = epochOf(draft?.sourcePosition);
  const basis = revisionId && byteDigest && epoch && document
    ? { revisionId, byteDigest, contentEpoch: epoch } : null;
  const value = document ? serializeDocument(document) : blankDocument();
  const published = record(row?.publishedPage);
  const publishedRevisionId = typeof published?.revisionId === 'string' && uuid.test(published.revisionId)
    ? published.revisionId : null;
  const serverEditable = draft?.editable !== false;
  return {
    value,
    expectedHead: revisionId,
    basis,
    ...(Array.isArray(embeds) ? { embeds } : {}),
    variantId,
    language,
    direction,
    zoneHead,
    navigationRevision: navigation,
    publishedRevisionId,
    editable: serverEditable && !notes && embeds !== 'invalid' && (draft?.document == null || document !== null),
    document,
  };
}

function navigationOf(zone: unknown): string | null {
  const revision = record(zone)?.revision;
  return typeof revision === 'string' && iri.test(revision) ? revision : null;
}

function ownerHead(zone: unknown): string | null {
  const revision = record(zone)?.ownerRevision;
  return typeof revision === 'string' && iri.test(revision) ? revision : null;
}

function languageOf(value: unknown, zoneLanguage: string): ContentLanguage {
  const row = record(value);
  if (row?.kind === 'tag' && typeof row.tag === 'string' && row.tag && typeof row.originalTag === 'string' && row.originalTag) {
    return { kind: 'tag', tag: row.tag, originalTag: row.originalTag };
  }
  const tag = zoneLanguage || 'und';
  return { kind: 'tag', tag, originalTag: tag };
}

function directionOf(value: unknown, zoneDirection: unknown): 'ltr' | 'rtl' | 'none' {
  if (value === 'ltr' || value === 'rtl' || value === 'none') return value;
  return zoneDirection === 'rtl' ? 'rtl' : 'ltr';
}

function embedsOf(value: unknown): string[] | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== 'string' || !uuid.test(item))) return 'invalid';
  return value;
}

function epochOf(value: unknown): string | null {
  const epoch = record(value)?.dataEpoch;
  return typeof epoch === 'string' && uuid.test(epoch) ? epoch : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export type { LoadedDraft };
