// SPDX-License-Identifier: Apache-2.0
import { unzipSync } from 'fflate';
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { posix } from 'node:path';
import type { Locator } from '../protocol/locator.ts';
import {
  source,
  bounds,
  quoteSelector,
  verified,
  type ParsedText,
  type TextUnit,
} from './types.ts';

const MAX_EXPANDED = 128 * 1024 * 1024;
const children = (node: Node): Node[] =>
  Array.from({ length: node.childNodes.length }, (_, i) => node.childNodes.item(i)!);
const elements = (node: Node) =>
  children(node).filter((child): child is Element => child.nodeType === 1);
const named = (node: Node, name: string): Element[] =>
  elements(node).flatMap((child) => [
    ...(child.localName === name ? [child] : []),
    ...named(child, name),
  ]);
const escape = (value: string) => value.replace(/[\^\[\](),;=]/g, '^$&');
const step = (element: Element, childIndex?: number) => {
  const index = childIndex ?? elements(element.parentNode!).indexOf(element);
  const id = element.getAttribute('id');
  return `/${(index + 1) * 2}${id ? `[${escape(id)}]` : ''}`;
};
function xml(bytes: Uint8Array | undefined) {
  if (!bytes) throw new Error('EPUB is missing a required XML document');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Unsupported EPUB XML encoding; UTF-8 is required');
  }
  // DTDs/entities are never loaded; common EPUB 2 public doctypes are inert.
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(text))
    throw new Error('Unsupported EPUB entity declaration');
  let malformed = false;
  const document = new DOMParser({
    onError: () => {
      malformed = true;
    },
  }).parseFromString(text, 'application/xml');
  if (malformed || !document.documentElement) throw new Error('Malformed EPUB XML');
  return document.documentElement;
}
function localPath(base: string, href: string) {
  if (/^[a-z][a-z\d+.-]*:|^\/|\\/i.test(href))
    throw new Error('EPUB references unsupported external content');
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split('#')[0]!);
  } catch {
    throw new Error('Invalid EPUB resource path');
  }
  if (/\\|\0/.test(decoded)) throw new Error('Invalid EPUB resource path');
  const path = posix.normalize(posix.join(posix.dirname(base), decoded));
  if (path.startsWith('../') || path.startsWith('/'))
    throw new Error('EPUB resource path leaves the publication');
  return path;
}
interface Atom {
  path: string;
  text: string;
  start: number;
  end: number;
}
interface Chapter {
  text: string;
  atoms: Atom[];
  prefix: string;
}
function extract(body: Element, prefix: string) {
  const atoms: Atom[] = [];
  const ruby: NonNullable<TextUnit['ruby']> = [];
  let text = '';
  const visit = (element: Element, path: string) => {
    if (['script', 'style', 'rt', 'rp'].includes(element.localName ?? '')) return;
    const rubyStart = text.length;
    let group = '',
      elementIndex = 0;
    const flush = () => {
      if (group) {
        atoms.push({
          path: `${path}/${elementIndex * 2 + 1}`,
          text: group,
          start: text.length,
          end: text.length + group.length,
        });
        text += group;
      }
      group = '';
    };
    for (const child of children(element)) {
      if (child.nodeType === 3 || child.nodeType === 4) group += child.nodeValue ?? '';
      else if (child.nodeType === 1) {
        flush();
        elementIndex++;
        const nested = child as Element;
        visit(nested, path + step(nested, elementIndex - 1));
      }
    }
    flush();
    if (element.localName === 'ruby')
      ruby.push({
        base: text.slice(rubyStart),
        reading: named(element, 'rt')
          .map((rt) => rt.textContent ?? '')
          .join(''),
        start: rubyStart,
        end: text.length,
      });
  };
  visit(body, '');
  return { chapter: { text, atoms, prefix }, ruby };
}
function cfi(chapter: Chapter, start: number, end: number): string {
  const first = chapter.atoms.find((atom) => start >= atom.start && start < atom.end);
  const last = chapter.atoms.find((atom) => end > atom.start && end <= atom.end);
  if (!first || !last) throw new Error('EPUB range is outside readable text');
  return `epubcfi(${chapter.prefix},${first.path}:${start - first.start},${last.path}:${end - last.start})`;
}
function splitCfi(value: string) {
  const parts: string[] = [];
  let part = '',
    bracket = false,
    escaped = false;
  for (const char of value.slice(8, -1)) {
    if (escaped) {
      part += char;
      escaped = false;
      continue;
    }
    if (char === '^') {
      part += char;
      escaped = true;
      continue;
    }
    if (char === '[') bracket = true;
    if (char === ']') bracket = false;
    if (char === ',' && !bracket) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  return parts;
}
const numericPath = (value: string) => value.replace(/\[(?:\^.|[^\]])*\]/g, '');
function samePath(requested: string, actual: string) {
  if (numericPath(requested) !== numericPath(actual)) return false;
  const steps = (value: string) => value.match(/\/\d+(?:\[(?:\^.|[^\]])*\])?/g) ?? [];
  const given = steps(requested),
    expected = steps(actual);
  return given.every((part, i) => !part.includes('[') || part === expected[i]);
}
/** Spine order is authoritative; navigation supplies labels only. No XML or archive entry is executed. */
export function parseEpub(bytes: Uint8Array): ParsedText {
  let expanded = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(entry) {
        expanded += entry.originalSize;
        if (expanded > MAX_EXPANDED)
          throw new Error('EPUB exceeds the 128 MiB expanded input budget');
        return true;
      },
    });
  } catch (error) {
    throw new Error(
      `Unsupported or protected EPUB: ${error instanceof Error ? error.message : 'invalid ZIP'}`,
    );
  }
  if (Buffer.from(files.mimetype ?? []).toString() !== 'application/epub+zip')
    throw new Error('Unsupported EPUB mimetype');
  const container = xml(files['META-INF/container.xml']);
  const rootfile = named(container, 'rootfile')[0];
  const packagePath = rootfile?.getAttribute('full-path');
  if (!packagePath) throw new Error('EPUB has no package document');
  const packageRoot = xml(files[localPath('', packagePath)]);
  if (!['2.0', '3.0'].includes(packageRoot.getAttribute('version') ?? ''))
    throw new Error('Unsupported EPUB version (expected 2 or 3)');
  const manifest = named(packageRoot, 'manifest')[0],
    spine = named(packageRoot, 'spine')[0];
  if (!manifest || !spine) throw new Error('EPUB has no manifest or spine');
  const items = new Map(elements(manifest).map((item) => [item.getAttribute('id'), item]));
  if (items.size !== elements(manifest).length) throw new Error('EPUB has duplicate manifest IDs');
  const fonts = new Set(
    elements(manifest)
      .filter((item) =>
        /^(?:font\/|application\/(?:font|vnd\.ms-opentype|x-font))/.test(
          item.getAttribute('media-type') ?? '',
        ),
      )
      .map((item) => localPath(packagePath, item.getAttribute('href') ?? '')),
  );
  if (files['META-INF/encryption.xml']) {
    for (const entry of named(xml(files['META-INF/encryption.xml']), 'EncryptedData')) {
      const algorithm = named(entry, 'EncryptionMethod')[0]?.getAttribute('Algorithm');
      const uri = named(entry, 'CipherReference')[0]?.getAttribute('URI');
      if (
        !uri ||
        !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(
          algorithm ?? '',
        ) ||
        !fonts.has(localPath('', uri))
      )
        throw new Error('Protected EPUB content is unsupported (only font obfuscation is ignored)');
    }
  }
  const labels = new Map<string, string>();
  for (const item of items.values()) {
    const isNav = (item.getAttribute('properties') ?? '').split(/\s+/).includes('nav');
    const isNcx = item.getAttribute('media-type') === 'application/x-dtbncx+xml';
    if (!isNav && !isNcx) continue;
    const path = localPath(packagePath, item.getAttribute('href') ?? '');
    const root = xml(files[path]);
    if (isNav)
      for (const link of named(root, 'a')) {
        const href = link.getAttribute('href');
        if (href && !/^[a-z][a-z\d+.-]*:/i.test(href))
          labels.set(localPath(path, href), link.textContent ?? '');
      }
    if (isNcx)
      for (const point of named(root, 'navPoint')) {
        const href = named(point, 'content')[0]?.getAttribute('src');
        if (href) labels.set(localPath(path, href), named(point, 'text')[0]?.textContent ?? '');
      }
  }
  const pinned = source(bytes, 'application/epub+zip');
  const units: TextUnit[] = [],
    chapters = new Map<string, Chapter>();
  const makeLocator = (chapter: Chapter, start: number, end: number): Locator => ({
    version: 'rezics-locator-v1',
    source: pinned,
    selector: { type: 'EpubCfiSelector', cfi: cfi(chapter, start, end) },
    quote: quoteSelector(chapter.text, start, end),
  });
  for (const [refIndex, ref] of elements(spine).entries()) {
    const item = items.get(ref.getAttribute('idref'));
    if (!item || item.getAttribute('media-type') !== 'application/xhtml+xml')
      throw new Error('Unsupported EPUB spine content (XHTML required)');
    const path = localPath(packagePath, item.getAttribute('href') ?? '');
    const root = xml(files[path]),
      body = named(root, 'body')[0];
    if (!body || root.localName !== 'html') throw new Error('Unsupported EPUB content document');
    const prefix = `${step(spine)}${step(ref, refIndex)}!`;
    const { chapter, ruby } = extract(body, prefix + step(body));
    if (!chapter.text.trim()) continue;
    const ordinal = units.length,
      id = `epub-${ordinal}`;
    chapters.set(id, chapter);
    units.push({
      id,
      ordinal,
      kind: 'chapter',
      label: labels.get(path) || named(body, 'h1')[0]?.textContent || `Spine item ${ordinal + 1}`,
      text: chapter.text,
      locator: makeLocator(chapter, 0, chapter.text.length),
      ruby,
      warnings: ['Spine items are proposed chapter units; confirm Work part alignment'],
    });
  }
  if (!units.length) throw new Error('EPUB has no readable text');
  return {
    units,
    locate(unit, start, end) {
      bounds(unit.text, start, end);
      const chapter = chapters.get(unit.id);
      if (!chapter || units[unit.ordinal] !== unit)
        throw new Error('Unit does not belong to this file');
      return makeLocator(chapter, start, end);
    },
    verify(locator) {
      if (locator.selector.type !== 'EpubCfiSelector')
        throw new Error('EPUB requires a range CFI locator');
      const [prefix, first, last] = splitCfi(locator.selector.cfi);
      const chapter = [...chapters.values()].find((value) => samePath(prefix ?? '', value.prefix));
      const position = (value: string | undefined) => {
        const match = /^(.*):(\d+)$/.exec(value ?? '');
        if (!chapter || !match) return undefined;
        const atom = chapter.atoms.find((item) => samePath(match[1]!, item.path));
        const offset = Number(match[2]);
        return atom && offset <= atom.text.length ? atom.start + offset : undefined;
      };
      const start = position(first),
        end = position(last);
      if (chapter && start !== undefined && end !== undefined)
        return verified(locator, chapter.text, start, end);
      // A fallback may recover a parser-local path difference only in the hash-pinned edition.
      if (locator.quote) {
        const matches: { chapter: Chapter; start: number; end: number }[] = [];
        for (const candidate of chapters.values()) {
          let start = candidate.text.indexOf(locator.quote.exact);
          while (start >= 0) {
            const end = start + locator.quote.exact.length;
            if (
              candidate.text.slice(0, start).endsWith(locator.quote.prefix ?? '') &&
              candidate.text.slice(end).startsWith(locator.quote.suffix ?? '')
            )
              matches.push({ chapter: candidate, start, end });
            start = candidate.text.indexOf(locator.quote.exact, start + 1);
          }
        }
        if (matches.length === 1) {
          const match = matches[0]!;
          return {
            ...verified(locator, match.chapter.text, match.start, match.end),
            resolution: 'quote-fallback',
          };
        }
      }
      throw new Error('EPUB CFI cannot be resolved unambiguously');
    },
  };
}
