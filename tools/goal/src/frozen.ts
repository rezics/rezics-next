import { createHash } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import { matchesPath } from './briefs.ts';

export type FrozenFile = { path: string; content: string; hash: string };

/** Keep the content and hash tied to the exact UTF-8 bytes written to disk. */
export function frozenFile(path: string, content: string | Uint8Array): FrozenFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`frozen file is not valid UTF-8: ${path}`);
  }
  return {
    path,
    content: text,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Read exact contents from fenced acceptance files embedded in a brief. */
export function parseFrozenFiles(markdown: string, declaredPaths: readonly string[]): FrozenFile[] {
  const files: FrozenFile[] = [];
  const names = new Set<string>();
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  let offset = 0;
  while (offset < markdown.length) {
    const line = lines.shift() ?? '';
    offset += line.length;
    const opening = /^(\s*)(`{3,}|~{3,})([^\r\n]*)/.exec(line.replace(/\r?\n$|\r$/, ''));
    if (!opening) continue;
    const info = opening[3]!;
    const pathMatch = /(?:^|\s)path=([^\s]+)/.exec(info);
    if (!pathMatch) continue;
    const path = pathMatch[1]!;
    if (
      !path ||
      path.includes('\\') ||
      path.includes('\0') ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[*?]/.test(path)
    )
      throw new Error(`invalid frozen file path: ${path}`);
    if (!matchesPath(path, declaredPaths)) throw new Error(`frozen file path is outside declared paths: ${path}`);
    if (names.has(path)) throw new Error(`duplicate frozen file path: ${path}`);
    const fence = opening[2]!;
    const closing = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*(?:\\r?\\n|\\r|$)`);
    const contentStart = offset;
    let contentEnd = -1;
    while (offset < markdown.length) {
      const current = lines.shift() ?? '';
      const currentStart = offset;
      offset += current.length;
      if (closing.test(current)) {
        contentEnd = currentStart;
        break;
      }
    }
    if (contentEnd < 0) throw new Error(`unclosed frozen file block: ${path}`);
    const content = markdown.slice(contentStart, contentEnd);
    files.push(frozenFile(path, content));
    names.add(path);
  }
  return files;
}
