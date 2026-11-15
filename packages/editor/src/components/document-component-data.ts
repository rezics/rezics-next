/** Clipboard metadata is existing node data in inert DOM attributes, never executable component code. */
function json(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function jsonValue(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (Array.isArray(current)) for (const child of current) pending.push(child);
    else if (Object.getPrototypeOf(current) === Object.prototype || Object.getPrototypeOf(current) === null)
      for (const child of Object.values(current)) pending.push(child);
    else return false;
  }
  return true;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const positive = (value: unknown) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
const commonNames = ['id', 'lang', 'dir'];
function common(value: Record<string, unknown>): boolean {
  return (
    (value.id === null || (nonempty(value.id) && value.id.length <= 256)) &&
    (value.lang === undefined ||
      value.lang === null ||
      (typeof value.lang === 'string' && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value.lang))) &&
    (value.dir === undefined || value.dir === null || ['ltr', 'rtl', 'auto'].includes(String(value.dir)))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(attrs: Record<string, unknown>, names: readonly string[]) {
  return Object.fromEntries(names.flatMap((name) => (attrs[name] === undefined ? [] : [[name, attrs[name]]])));
}

export function componentDOMAttributes(attrs: Record<string, unknown>): Record<string, string> {
  return {
    'data-document-component': String(attrs.definition),
    'data-document-component-definition': JSON.stringify(attrs.definition),
    'data-document-component-version': JSON.stringify(attrs.version),
    'data-document-component-payload': JSON.stringify(attrs.payload),
    'data-document-component-fallback': JSON.stringify(attrs.fallback),
    ...(attrs.id ? { 'data-block-id': String(attrs.id) } : {}),
  };
}
export function parseComponentAttributes(element: HTMLElement): Record<string, unknown> | false {
  const definition = json(element.getAttribute('data-document-component-definition'));
  const version = json(element.getAttribute('data-document-component-version'));
  const fallback = json(element.getAttribute('data-document-component-fallback'));
  const payload = json(element.getAttribute('data-document-component-payload'));
  if (!nonempty(definition) || !nonempty(version) || typeof fallback !== 'string' || !jsonValue(payload)) return false;
  return { id: element.getAttribute('data-block-id'), definition, version, payload, fallback };
}
export function imageDOMAttributes(attrs: Record<string, unknown>): Record<string, string> {
  return {
    'data-document-image': JSON.stringify(
      fields(attrs, [...commonNames, 'src', 'alt', 'title', 'width', 'height', 'conceal']),
    ),
  };
}
export function parseImageAttributes(element: HTMLElement): Record<string, unknown> | false {
  const value = json(element.getAttribute('data-document-image'));
  const allowed = new Set([...commonNames, 'src', 'alt', 'title', 'width', 'height', 'conceal']);
  return record(value) &&
    common(value) &&
    Object.keys(value).every((name) => allowed.has(name)) &&
    nonempty(value.src) &&
    nullableText(value.alt) &&
    nullableText(value.title) &&
    positive(value.width) &&
    positive(value.height) &&
    typeof value.conceal === 'boolean'
    ? value
    : false;
}
export function mediaDOMAttributes(attrs: Record<string, unknown>): Record<string, string> {
  return { 'data-document-media': JSON.stringify(fields(attrs, [...commonNames, 'src', 'kind', 'caption'])) };
}
export function parseMediaAttributes(element: HTMLElement): Record<string, unknown> | false {
  const value = json(element.getAttribute('data-document-media'));
  const allowed = new Set([...commonNames, 'src', 'kind', 'caption']);
  return record(value) &&
    common(value) &&
    Object.keys(value).every((name) => allowed.has(name)) &&
    nonempty(value.src) &&
    ['audio', 'video', 'file'].includes(String(value.kind)) &&
    typeof value.caption === 'string'
    ? value
    : false;
}

/** Images enter ProseMirror as inert occurrence data, never as a browser request to an unadmitted src. */
export function normalizeMediaClipboardDOM(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const number = (name: string) => {
      const value = Number(image.getAttribute(name));
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const lang = image.getAttribute('lang');
    const dir = image.getAttribute('dir');
    const attrs = {
      id: image.getAttribute('data-block-id'),
      src: image.getAttribute('src'),
      alt: image.getAttribute('alt'),
      title: image.getAttribute('title'),
      width: number('width'),
      height: number('height'),
      conceal: image.getAttribute('data-conceal') === 'true',
      lang: lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null,
      dir: dir && ['ltr', 'rtl', 'auto'].includes(dir) ? dir : null,
    };
    const replacement = image.ownerDocument.createElement('figure');
    for (const [name, value] of Object.entries(imageDOMAttributes(attrs))) replacement.setAttribute(name, value);
    replacement.textContent = attrs.alt || 'Image';
    image.replaceWith(replacement);
  }
}
