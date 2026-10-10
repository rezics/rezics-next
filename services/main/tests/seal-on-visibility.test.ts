import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const sourceRoot = join(import.meta.dir, '../src');

/** A receipt write in the same function as a visibility catch. An open admission
 * that is claimed again is not a receipt. */
const receiptWrite = /sealTerminal|sealMetadataWorkEditAdmission|sealContentDraftAdmission|recordGraphOutcome|saveReceipt\(|acknowledgeSubmission|sealSemanticRejection|sealStandingRatingAdmission|sealRatingContextAdmission|sealCommandTerminal|sealRealmSelectionAdmission|INSERT INTO access\.(?:follow_receipt|reader_review_receipt)/;

/**
 * Sites whose function both catches a current-visibility miss and writes a
 * receipt. Each reason is why that write is not a sealed refusal of visibility.
 * A hidden target and an absent one stay the same answer, including retry.
 */
const allowlist: Record<string, string> = {
  'modules/profiles/credits.ts#createNativeCredit':
    'The catch rethrows the visibility miss before any receipt. recordGraphOutcome runs only after a completed edit already has its terminal receipt.',
  'modules/realm-reply/store.ts#create':
    'Launch owns the reply command. The route answers before create, so a root that is not visible yet is never registered. The store still seals a miss that happens inside create.',
};

interface Body { name: string; start: number; end: number }

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Replace comments and string contents with spaces so brace matching sees code.
 * Template interpolations stay visible; their literal text does not. */
function mask(source: string): string {
  const out: string[] = [];
  const space = (n: number) => { for (let k = 0; k < n; k++) out.push(' '); };
  const scanString = (start: number, quote: string): number => {
    space(1);
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\') { space(2); i += 2; continue; }
      if (source[i] === quote) { space(1); return i + 1; }
      space(1);
      i++;
    }
    return i;
  };
  const scanTemplate = (start: number): number => {
    space(1);
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\') { space(2); i += 2; continue; }
      if (source[i] === '`') { space(1); return i + 1; }
      if (source[i] === '$' && source[i + 1] === '{') {
        space(2);
        i = scan(i + 2, true);
        space(1);
        i++;
        continue;
      }
      space(1);
      i++;
    }
    return i;
  };
  const scanRegex = (start: number): number => {
    space(1);
    let i = start + 1;
    let klass = false;
    while (i < source.length) {
      if (source[i] === '\\') { space(2); i += 2; continue; }
      if (source[i] === '\n') return i;
      if (source[i] === '[') klass = true;
      else if (source[i] === ']') klass = false;
      else if (source[i] === '/' && !klass) {
        space(1);
        i++;
        while (i < source.length && /[dgimsuy]/.test(source[i]!)) { space(1); i++; }
        return i;
      }
      space(1);
      i++;
    }
    return i;
  };
  const scan = (start: number, interpolation: boolean): number => {
    let i = start;
    let depth = 0;
    let canRegex = true;
    let word = '';
    const finishWord = () => {
      if (word) canRegex = /^(?:return|throw|case|typeof|void|delete|in|of|instanceof|yield|await|else|do|typeof)$/.test(word);
      word = '';
    };
    while (i < source.length) {
      if (source.startsWith('//', i)) {
        finishWord();
        const end = source.indexOf('\n', i);
        const stop = end < 0 ? source.length : end;
        space(stop - i);
        i = stop;
        continue;
      }
      if (source.startsWith('/*', i)) {
        finishWord();
        const end = source.indexOf('*/', i + 2);
        const stop = end < 0 ? source.length : end + 2;
        space(stop - i);
        i = stop;
        continue;
      }
      const quote = source[i];
      if (quote === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && canRegex) {
        finishWord();
        i = scanRegex(i);
        canRegex = false;
        continue;
      }
      if (quote === "'" || quote === '"') { finishWord(); i = scanString(i, quote); canRegex = false; continue; }
      if (quote === '`') { finishWord(); i = scanTemplate(i); canRegex = false; continue; }
      if (quote === '{') { finishWord(); depth++; out.push('{'); canRegex = true; i++; continue; }
      if (quote === '}') {
        finishWord();
        if (interpolation && depth === 0) return i;
        depth--;
        out.push('}');
        canRegex = false;
        i++;
        continue;
      }
      if (/[A-Za-z0-9_$]/.test(quote!)) word += quote;
      else finishWord();
      if (/[=(\[{,;:!&|?+\-*%~^<>]/.test(quote!)) canRegex = true;
      else if (!/\s/.test(quote!)) canRegex = false;
      out.push(source[i]!);
      i++;
    }
    return i;
  };
  scan(0, false);
  return out.join('');
}

function closeBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const notFunction = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else']);

function skipSpaceBack(masked: string, index: number): number {
  let i = index;
  while (i >= 0 && /\s/.test(masked[i]!)) i--;
  return i;
}

function skipBalancedBack(masked: string, index: number, open: string, close: string): number {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    if (masked[i] === close) depth++;
    else if (masked[i] === open) {
      depth--;
      if (depth === 0) return i - 1;
    }
  }
  return -1;
}

function functionNameAt(masked: string, brace: number): string | null {
  let i = skipSpaceBack(masked, brace - 1);
  if (i >= 1 && masked[i] === '>' && masked[i - 1] === '=') {
    i = skipSpaceBack(masked, i - 2);
    if (masked[i] === '>') i = skipBalancedBack(masked, i, '<', '>');
    i = skipSpaceBack(masked, i);
    while (i >= 0 && /[A-Za-z0-9_.|&]/.test(masked[i]!)) i--;
    i = skipSpaceBack(masked, i);
    if (masked[i] === ':') i = skipSpaceBack(masked, i - 1);
    if (masked[i] === ')') i = skipBalancedBack(masked, i, '(', ')');
    else while (i >= 0 && /[A-Za-z0-9_]/.test(masked[i]!)) i--;
    const named = masked.slice(Math.max(0, i - 160), i + 1).match(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?$/);
    return named?.[1] ?? 'anonymous';
  }
  if (masked[i] === '>') i = skipBalancedBack(masked, i, '<', '>');
  i = skipSpaceBack(masked, i);
  while (i >= 0 && /[A-Za-z0-9_.]/.test(masked[i]!)) i--;
  i = skipSpaceBack(masked, i);
  if (masked[i] === ':') i = skipSpaceBack(masked, i - 1);
  if (masked[i] !== ')') return null;
  i = skipBalancedBack(masked, i, '(', ')');
  if (i < 0) return null;
  i = skipSpaceBack(masked, i);
  if (masked[i] === '>') i = skipSpaceBack(masked, skipBalancedBack(masked, i, '<', '>'));
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(masked[i]!)) i--;
  const name = masked.slice(i + 1, end);
  if (!name || notFunction.has(name)) {
    const keyword = masked.slice(Math.max(0, i - 12), i + 1);
    if (/\bfunction\s*$/.test(keyword)) return 'anonymous';
    return null;
  }
  return name;
}

function functions(masked: string): Body[] {
  const found: Body[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '{') continue;
    const name = functionNameAt(masked, i);
    if (!name) continue;
    const end = closeBrace(masked, i);
    if (end > i) found.push({ name, start: i, end });
  }
  return found;
}

function visibilitySeals(path: string, source: string): { seals: string[]; unscoped: string[] } {
  const masked = mask(source);
  const bodies = functions(masked);
  const seals: string[] = [];
  const unscoped: string[] = [];
  const file = relative(sourceRoot, path).replaceAll('\\', '/');
  const pattern = /instanceof\s+(?:WorkReadMissing|TargetUnavailable)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const body = bodies.filter(item => item.start < match!.index && match!.index < item.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    if (!body) { unscoped.push(`${file}:${source.slice(0, match.index).split('\n').length}`); continue; }
    if (!receiptWrite.test(source.slice(match.index, body.end))) continue;
    seals.push(`${file}#${body.name}`);
  }
  return { seals: [...new Set(seals)], unscoped };
}

test('a command catch of a visibility miss does not write a receipt unless the audit allows it', () => {
  const found = new Map<string, true>();
  const unscoped: string[] = [];
  for (const path of walk(sourceRoot)) {
    const hit = visibilitySeals(path, readFileSync(path, 'utf8'));
    for (const seal of hit.seals) found.set(seal, true);
    unscoped.push(...hit.unscoped);
  }
  const unexpected = [...found.keys()].filter(hit => !allowlist[hit]).sort();
  const stale = Object.keys(allowlist).filter(hit => !found.has(hit)).sort();
  expect(unscoped).toEqual([]);
  expect({ unexpected, stale, found: [...found.keys()].sort() }).toEqual({ unexpected: [], stale: [], found: Object.keys(allowlist).sort() });
});

test('a native credit does not seal and then report the Agent missing', () => {
  const source = readFileSync(join(sourceRoot, 'modules/profiles/credits.ts'), 'utf8');
  expect(source).not.toMatch(/sealMetadataWorkEditAdmission\([^)]*\)\s*;\s*throw new WorkReadMissing/);
});

test('a realm submission candidate miss is not in the terminal cancellation list', () => {
  const source = readFileSync(join(sourceRoot, 'modules/realm-submission/store.ts'), 'utf8');
  const cancellation = source.slice(source.indexOf('Only definite pre-commit'), source.indexOf('throw error;', source.indexOf('Only definite pre-commit')));
  expect(cancellation).not.toContain('WorkReadMissing');
  expect(readFileSync(join(sourceRoot, 'modules/realm-submission/graph.ts'), 'utf8')).toContain("throw new WorkReadMissing('Exact public candidate is unavailable')");
  expect(readFileSync(join(sourceRoot, 'modules/realm-submission/resource.ts'), 'utf8')).toContain("throw new WorkReadMissing('Exact Work or public Content publication is unavailable')");
});
