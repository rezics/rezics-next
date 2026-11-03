import { checkDocument, topLevelNodeNames, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { CurrentPost } from './actions';

/** Both the installed native document validator and editor admit at most 2 MiB. */
export const conflictInspectionLimits = Object.freeze({ bytes: 2 * 1024 * 1024, page: 10, label: 96 });

/** Presentation only. The composer retains its document, uploads and command intent. */
export type ConflictDraftReading = Readonly<{ body: DocumentSnapshot; revision: number }>;
export type ConflictPresentation = ConflictDraftReading & {
  /** Identity of the original mounted authoring admission, never a replacement session. */
  authority: object;
  inspectable: boolean;
  signal: AbortSignal;
  /** Must consult synchronous editor revision and admission refs, not a captured render. */
  read: () => ConflictDraftReading | null;
};

export type ConflictSectionKind =
  | 'text'
  | 'heading'
  | 'list'
  | 'quote'
  | 'code'
  | 'table'
  | 'image'
  | 'media'
  | 'component'
  | 'divider'
  | 'unsupported';

export type ConflictSection = Readonly<{
  /** Top-level offset, not a revision number or inferred correspondence with the other writing. */
  offset: number;
  kind: ConflictSectionKind;
  label: string;
  concealed: boolean;
}>;
export type ConflictProjection =
  | Readonly<{
      state: 'ready';
      body: DocumentSnapshot;
      bytes: number;
      sections: readonly ConflictSection[];
      nodes: number;
    }>
  | Readonly<{ state: 'too-large' | 'unsupported'; bytes: number }>;

const kinds: Readonly<Record<string, ConflictSectionKind>> = {
  paragraph: 'text',
  heading: 'heading',
  bulletList: 'list',
  orderedList: 'list',
  taskList: 'list',
  blockquote: 'quote',
  codeBlock: 'code',
  table: 'table',
  image: 'image',
  media: 'media',
  extensionBlock: 'component',
  horizontalRule: 'divider',
};

/**
 * One label walk over admitted nodes. Only bounded labels and top-level offsets survive;
 * no document tree, paragraph text, edit-distance matrix or serialized body is retained.
 * Codec admission and UTF-8 sizing each add a linear pass over the installed byte bound.
 */
export function projectConflictDocument(body: DocumentSnapshot): ConflictProjection {
  let bytes: number;
  try {
    const serialized = JSON.stringify(body);
    // Every UTF-16 code unit consumes at least one UTF-8 byte in JSON.
    if (serialized.length > conflictInspectionLimits.bytes) return { state: 'too-large', bytes: serialized.length };
    bytes = new TextEncoder().encode(serialized).byteLength;
  } catch {
    return { state: 'unsupported', bytes: 0 };
  }
  if (bytes > conflictInspectionLimits.bytes) return { state: 'too-large', bytes };
  if (!checkDocument(body)) return { state: 'unsupported', bytes };
  const sections: ConflictSection[] = [];
  let nodes = 0;
  const supported = topLevelNodeNames(body.profile);
  for (const [offset, block] of (body.doc.content ?? []).entries()) {
    const kind = supported.has(block.type) ? (kinds[block.type] ?? 'unsupported') : 'unsupported';
    const characters: string[] = [];
    let concealed = false;
    let space = false;
    const stack: DocumentNode[] = [block];
    while (stack.length) {
      const node = stack.pop()!;
      nodes++;
      const hidden = node.marks?.some((mark) => mark.type === 'spoiler') ?? false;
      concealed ||= hidden;
      // No spoiler text, image alt, component payload or guessed mention identity in the index.
      if (!hidden && node.type === 'text' && typeof node.text === 'string') {
        for (const character of node.text) {
          if (characters.length >= conflictInspectionLimits.label) break;
          if (/\s/u.test(character)) {
            space = characters.length > 0;
          } else {
            if (space && characters.length < conflictInspectionLimits.label) characters.push(' ');
            space = false;
            if (characters.length < conflictInspectionLimits.label) characters.push(character);
          }
        }
      }
      const children = node.content ?? [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
    sections.push({ offset, kind, label: characters.join(''), concealed });
  }
  return { state: 'ready', body, bytes, sections, nodes };
}

export type ConflictInvalidation = 'draft' | 'current' | 'retired';

/** A visit binds references and scalar identities, without cloning either writing. */
export class ConflictInspection {
  private retained: {
    current: CurrentPost;
    id: string;
    threadId: string;
    securityRevision: string;
    sha256: CurrentPost['sha256'];
    body: CurrentPost['body'];
    revisionId: string;
    availability: CurrentPost['availability'];
    licence: string;
    mediaIds: CurrentPost['mediaIds'];
    presentation: ConflictPresentation | undefined;
    draft: ConflictDraftReading | undefined;
    draftProjection: ConflictProjection | undefined;
    currentProjection: ConflictProjection | undefined;
  } | null;
  private reason: ConflictInvalidation | null = null;

  constructor(current: CurrentPost, presentation?: ConflictPresentation) {
    this.retained = {
      current,
      id: current.id,
      threadId: current.threadId,
      securityRevision: current.securityRevision,
      sha256: current.sha256,
      body: current.body,
      revisionId: current.revisionId,
      availability: current.availability,
      licence: current.licence,
      mediaIds: current.mediaIds,
      presentation,
      draft: presentation ? { body: presentation.body, revision: presentation.revision } : undefined,
      draftProjection: presentation ? projectConflictDocument(presentation.body) : undefined,
      currentProjection:
        presentation && current.availability === 'available' && current.body !== null
          ? projectConflictDocument(current.body)
          : undefined,
    };
  }

  /** Invalidation is permanent, including a changed-away-then-back revision or admission. */
  validate(current: CurrentPost | undefined, presentation?: ConflictPresentation): ConflictInvalidation | null {
    if (this.reason) return this.reason;
    const retained = this.retained;
    if (!retained) return 'retired';
    if (!!presentation !== !!retained.presentation) return this.invalidate('retired');
    if (
      retained.presentation &&
      (!presentation ||
        presentation.authority !== retained.presentation.authority ||
        presentation.signal !== retained.presentation.signal ||
        retained.presentation.signal.aborted)
    )
      return this.invalidate('retired');
    if (
      current !== retained.current ||
      !current ||
      current.id !== retained.id ||
      current.threadId !== retained.threadId ||
      current.securityRevision !== retained.securityRevision ||
      current.sha256 !== retained.sha256 ||
      current.body !== retained.body ||
      current.revisionId !== retained.revisionId ||
      current.availability !== retained.availability ||
      current.licence !== retained.licence ||
      current.mediaIds !== retained.mediaIds
    )
      return this.invalidate('current');
    if (retained.draft) {
      const reading = presentation?.read();
      if (!reading) return this.invalidate('retired');
      if (!presentation?.inspectable) return this.invalidate('draft');
      if (
        reading.revision !== retained.draft.revision ||
        reading.body !== retained.draft.body ||
        presentation?.revision !== retained.draft.revision ||
        presentation.body !== retained.draft.body
      )
        return this.invalidate('draft');
    }
    return null;
  }

  get draft(): ConflictDraftReading | undefined {
    return this.retained?.draft;
  }

  get current(): CurrentPost | undefined {
    return this.retained?.current;
  }

  get draftProjection(): ConflictProjection | undefined {
    return this.retained?.draftProjection;
  }

  get currentProjection(): ConflictProjection | undefined {
    return this.retained?.currentProjection;
  }

  /** The original callback receives only the original admitted result, never a projection. */
  replacement(current: CurrentPost | undefined, presentation?: ConflictPresentation): CurrentPost | null {
    if (this.validate(current, presentation)) return null;
    const post = this.retained?.current;
    return post?.availability === 'available' &&
      post.body !== null &&
      (!this.retained?.presentation ||
        (this.retained.currentProjection?.state === 'ready' && this.retained.draftProjection?.state === 'ready'))
      ? post
      : null;
  }

  private invalidate(reason: ConflictInvalidation): ConflictInvalidation {
    this.reason = reason;
    this.retained = null;
    return reason;
  }

  clear(): void {
    this.invalidate('retired');
  }
}
