import {
  documentText,
  documentVersion,
  fromMarkdown,
  fromPlainText,
  parseDocument,
  normalizeDocument,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';

/** File bytes and serialized editor bytes are different bounds: text can expand into blocks. */
export const portableWritingLimits = Object.freeze({
  fileBytes: 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  depth: 64,
});
export type WritingFormat = 'json' | 'text' | 'markdown';
export type WritingExport = 'json' | 'text' | 'raw';
export type PortableErrorCode =
  | 'type'
  | 'size'
  | 'read'
  | 'json'
  | 'document'
  | 'depth'
  | 'expanded'
  | 'changed'
  | 'busy'
  | 'pending'
  | 'recovery'
  | 'download'
  | 'copy';
export class PortableWritingError extends Error {
  constructor(readonly code: PortableErrorCode) {
    super(code);
    this.name = 'PortableWritingError';
  }
}
export type WritingRepairs = Readonly<{ attachments: number; components: number; links: number }>;
export type AdmittedWriting = Readonly<{
  body: DocumentSnapshot;
  text: string;
  repairs: WritingRepairs;
  format: WritingFormat;
  inputBytes: number;
  nodes: number;
}>;
export type LocalWritingFile = Pick<File, 'name' | 'size' | 'text'>;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const fail = (code: PortableErrorCode): never => {
  throw new PortableWritingError(code);
};

/** Extensions determine the explicitly requested codec, never publication or media authority. */
export function writingFormat(name: string): WritingFormat {
  if (/\.json$/i.test(name)) return 'json';
  if (/\.txt$/i.test(name)) return 'text';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  return fail('type');
}

/** Bound recursion before calling the installed recursive codecs, without mutating IDs. */
function inspect(value: unknown): number {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > portableWritingLimits.depth) fail('depth');
    if (!item.value || typeof item.value !== 'object') continue;
    if (!Array.isArray(item.value) && 'type' in item.value) nodes++;
    for (const child of Object.values(item.value)) {
      if (child && typeof child === 'object') stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return nodes;
}

function safeLink(value: unknown): boolean {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value, 'https://portable.invalid');
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return false;
    // Bearer URLs are capabilities too. Authored text remains text; it is never interpreted as a command.
    for (const name of url.searchParams.keys()) {
      if (/token|secret|credential|password|signature|authorization|csrf|session|api.?key/i.test(name)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A projection of a validated snapshot, never a browser DTO granting native attachment permission. */
function portableProjection(snapshot: DocumentSnapshot): { body: DocumentSnapshot; repairs: WritingRepairs } {
  const repairs = { attachments: 0, components: 0, links: 0 };
  const visit = (node: DocumentNode): DocumentNode => {
    const attachment = node.type === 'image' || node.type === 'media';
    const component = node.type === 'extensionBlock' || node.type === 'extensionInline';
    if (attachment || component) {
      if (attachment) repairs.attachments++;
      else repairs.components++;
      const label = attachment ? (node.attrs?.alt ?? node.attrs?.caption) : node.attrs?.fallback;
      const text = typeof label === 'string' ? label : '';
      if (node.type === 'extensionInline') return { type: 'text', text: text || ' ' };
      return {
        type: 'paragraph',
        attrs: { id: node.attrs!.id! },
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      };
    }
    const marks = node.marks?.filter((mark) => {
      if (mark.type !== 'link' || safeLink(mark.attrs?.href)) return true;
      repairs.links++;
      return false;
    });
    return {
      ...node,
      ...(node.content ? { content: node.content.map(visit) } : {}),
      ...(marks ? { marks } : {}),
    };
  };
  return {
    body: normalizeDocument({ version: documentVersion, profile: 'blocks', doc: visit(snapshot.doc) }),
    repairs,
  };
}

/** One codec admission per file. Unsupported nodes/attributes are refused as a whole, never silently dropped. */
export function admitWriting(source: string, format: WritingFormat): AdmittedWriting {
  const inputBytes = bytes(source);
  if (inputBytes > portableWritingLimits.fileBytes) fail('size');
  let body: DocumentSnapshot;
  let nodes: number;
  if (format === 'json') {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return fail('json');
    }
    nodes = inspect(value);
    try {
      body = parseDocument(value);
    } catch {
      return fail('document');
    }
  } else {
    if (format === 'text') {
      // Each line needs at least a paragraph shell and an ID. Refuse certain expansion before allocating it.
      let lines = 1;
      for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n' || (source[index] === '\r' && source[index + 1] !== '\n')) lines++;
      }
      if (lines * 40 > portableWritingLimits.snapshotBytes) fail('expanded');
    }
    if (format === 'markdown' && /(?:>!){65}/u.test(source)) fail('depth');
    try {
      body = format === 'markdown' ? fromMarkdown(source, 'blocks') : fromPlainText(source, 'blocks');
    } catch {
      return fail('document');
    }
    nodes = inspect(body);
  }
  const projected = portableProjection(body);
  if (bytes(JSON.stringify(projected.body)) > portableWritingLimits.snapshotBytes) fail('expanded');
  return Object.freeze({ ...projected, text: documentText(projected.body), format, inputBytes, nodes });
}

export type WritingDownload = Readonly<{
  content: string;
  filename: string;
  mediaType: string;
  repairs: WritingRepairs;
  kind: WritingExport;
}>;
export function exportWriting(body: DocumentSnapshot, kind: 'json' | 'text'): WritingDownload {
  inspect(body);
  try {
    parseDocument(body);
  } catch {
    return fail('recovery');
  }
  const projected = portableProjection(body);
  let content: string;
  try {
    content = kind === 'json' ? serializeDocument(projected.body) : documentText(projected.body);
  } catch {
    return fail('recovery');
  }
  if (bytes(content) > portableWritingLimits.snapshotBytes) fail('expanded');
  return {
    content,
    filename: kind === 'json' ? 'unsent-writing.rezics.json' : 'unsent-writing.txt',
    mediaType: kind === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
    repairs: projected.repairs,
    kind,
  };
}

/** Recovery exports only editor node structure and authored strings, never arbitrary envelope/payload fields. */
export function exportRawWriting(raw: DocumentNode): WritingDownload {
  inspect(raw);
  const visit = (node: DocumentNode): Record<string, unknown> => ({
    type: node.type,
    ...(typeof node.text === 'string'
      ? { text: node.text }
      : typeof (node.attrs?.alt ?? node.attrs?.caption ?? node.attrs?.fallback) === 'string'
        ? { text: node.attrs?.alt ?? node.attrs?.caption ?? node.attrs?.fallback }
        : {}),
    ...(node.content ? { content: node.content.map(visit) } : {}),
    ...(node.marks ? { marks: node.marks.map((mark) => ({ type: mark.type })) } : {}),
  });
  const content = JSON.stringify({ recovery: 'unnormalized-editor-work', doc: visit(raw) }, null, 2);
  if (bytes(content) > portableWritingLimits.snapshotBytes) fail('expanded');
  return {
    content,
    filename: 'unsent-writing.raw-recovery.json',
    mediaType: 'application/json',
    repairs: { attachments: 0, components: 0, links: 0 },
    kind: 'raw',
  };
}

export type WritingPreview = AdmittedWriting & { revision: number };
export type WritingTransferState = Readonly<{
  open: boolean;
  reading: boolean;
  preview: WritingPreview | null;
  error: PortableErrorCode | null;
  download: WritingDownload | null;
  downloaded: boolean;
  copied: boolean;
}>;
export type WritingSource = {
  current: () => boolean;
  signal: AbortSignal;
  revision: () => number;
  replaceable: () => boolean;
  snapshot: () => { body: DocumentSnapshot; phase: 'ready' | 'pending' | 'failed'; raw: DocumentNode | null };
  replace: (body: DocumentSnapshot) => void;
  focus: () => void;
};
export type WritingBrowser = {
  createURL: (blob: Blob) => string;
  revokeURL: (url: string) => void;
  download: (url: string, name: string) => void;
  copy: (text: string) => Promise<void>;
};
const initialState = (): WritingTransferState => ({
  open: false,
  reading: false,
  preview: null,
  error: null,
  download: null,
  downloaded: false,
  copied: false,
});

/** Current-visit file custody only. No storage, fetch, retry loop, command or publication owner. */
export class PortableWriting {
  private state = initialState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private objectURL: string | null = null;
  private retired = false;
  constructor(
    private source: WritingSource,
    private browser: WritingBrowser,
  ) {
    source.signal.addEventListener('abort', this.retire, { once: true });
    if (source.signal.aborted) this.retire();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private emit(next: Partial<WritingTransferState>) {
    this.state = Object.freeze({ ...this.state, ...next });
    for (const listener of this.listeners) listener();
  }
  private current() {
    if (this.retired) return false;
    if (!this.source.current() || this.source.signal.aborted) {
      this.retire();
      return false;
    }
    return true;
  }
  private revoke() {
    const url = this.objectURL;
    this.objectURL = null;
    if (url !== null) this.browser.revokeURL(url);
  }
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.generation++;
    this.revoke();
    this.source.signal.removeEventListener('abort', this.retire);
    this.emit(initialState());
  };
  toggle = () => {
    if (!this.current()) return;
    if (this.state.open) this.close();
    else this.emit({ open: true });
  };
  close = () => {
    if (!this.current()) return;
    this.generation++;
    this.revoke();
    this.emit(initialState());
    this.source.focus();
  };
  cancel = () => {
    if (!this.current()) return;
    this.generation++;
    this.emit({ reading: false, preview: null, error: null });
    this.source.focus();
  };
  /** A synchronous editor transaction invalidates a preview even before its debounced snapshot arrives. */
  changed = () => {
    if (!this.current()) return;
    this.generation++;
    if (this.state.preview || this.state.reading) this.emit({ preview: null, reading: false, error: 'changed' });
    if (this.state.download) {
      this.revoke();
      this.emit({ download: null, downloaded: false, copied: false });
    }
  };
  async select(file: LocalWritingFile | null): Promise<void> {
    if (!this.current()) return;
    // Cancelling the native chooser must not read or discard the existing draft.
    if (!file) return;
    const generation = ++this.generation;
    this.revoke();
    this.emit({
      open: true,
      reading: false,
      preview: null,
      error: null,
      download: null,
      downloaded: false,
      copied: false,
    });
    if (!this.source.replaceable()) {
      this.emit({ error: 'busy' });
      return;
    }
    const revision = this.source.revision();
    let format: WritingFormat;
    try {
      if (!Number.isFinite(file.size) || file.size < 0 || file.size > portableWritingLimits.fileBytes) fail('size');
      format = writingFormat(file.name);
    } catch (error) {
      this.emit({ error: this.errorCode(error) });
      return;
    }
    this.emit({ reading: true });
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (this.current() && generation === this.generation) this.emit({ reading: false, error: 'read' });
      return;
    }
    if (!this.current() || generation !== this.generation) return;
    if (revision !== this.source.revision()) {
      this.emit({ reading: false, error: 'changed' });
      return;
    }
    if (!this.source.replaceable()) {
      this.emit({ reading: false, error: 'busy' });
      return;
    }
    try {
      const admitted = admitWriting(text, format);
      this.emit({ reading: false, preview: { ...admitted, revision } });
    } catch (error) {
      this.emit({ reading: false, error: this.errorCode(error) });
    }
  }
  confirm = () => {
    if (!this.current()) return;
    const preview = this.state.preview;
    if (!preview) return;
    if (preview.revision !== this.source.revision()) {
      this.emit({ preview: null, error: 'changed' });
      return;
    }
    if (!this.source.replaceable()) {
      this.emit({ preview: null, error: 'busy' });
      return;
    }
    this.generation++;
    this.emit({ preview: null, error: null });
    this.source.replace(preview.body);
    if (this.current()) this.source.focus();
  };
  export = (kind: WritingExport) => {
    if (!this.current()) return;
    this.revoke();
    this.emit({ open: true, download: null, downloaded: false, copied: false, error: null });
    try {
      const snapshot = this.source.snapshot();
      if (snapshot.phase === 'pending') fail('pending');
      if (kind !== 'raw' && snapshot.phase === 'failed') fail('recovery');
      if (kind === 'raw' && (snapshot.phase !== 'failed' || !snapshot.raw)) fail('recovery');
      const download = kind === 'raw' ? exportRawWriting(snapshot.raw!) : exportWriting(snapshot.body, kind);
      this.emit({ download });
      try {
        const url = this.browser.createURL(new Blob([download.content], { type: download.mediaType }));
        this.objectURL = url;
        this.browser.download(url, download.filename);
        this.emit({ downloaded: true });
      } catch {
        this.revoke();
        this.emit({ error: 'download' });
      }
    } catch (error) {
      this.emit({ error: this.errorCode(error) });
    }
  };
  copy = async () => {
    if (!this.current() || !this.state.download) return;
    const download = this.state.download;
    const generation = this.generation;
    try {
      await this.browser.copy(download.content);
      if (this.current() && this.state.download === download && generation === this.generation)
        this.emit({ copied: true, error: null });
    } catch {
      if (this.current() && this.state.download === download && generation === this.generation)
        this.emit({ copied: false, error: 'copy' });
    }
  };
  private errorCode(error: unknown): PortableErrorCode {
    return error instanceof PortableWritingError ? error.code : 'document';
  }
}
