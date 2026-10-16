import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { searchOperations, type IndexedOperation } from '../api/operation-index.ts';
import type { PersonaName } from '../../tests/qa/support/personas.ts';
import { answerPersonas, clientResponseHeaders, recordAnswer, redactAnswer, type AnswerCall, type RecordedAnswer } from '../api/answer-record.ts';

// Keep validation independent of the test-only application composition and its environment.
export const probePersonas = answerPersonas satisfies readonly PersonaName[];
export interface ProbeCall extends AnswerCall {
  persona: PersonaName;
}
export interface ProbeAnswer extends ProbeCall, RecordedAnswer {
  elapsedSeconds: number;
}
export interface ProbeResult {
  visibility: 'public' | 'private';
  setupSeconds: number;
  calls: ProbeAnswer[];
  error?: string;
}
export const probeHeaders = clientResponseHeaders;
const placeholder = /\{(realm|space|zone|[1-9]\d*\.[A-Za-z0-9_.-]+)\}/g;
/** Only application data crosses the probe boundary; credentials never do. */
export const redactProbe = redactAnswer;

function pathParts(path: string): [string, string] {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) throw new Error('A call needs an absolute service path');
  const at = path.indexOf('?');
  const pathname = at < 0 ? path : path.slice(0, at);
  if (pathname.split('/').some(segment => {
    const decoded = decodeURIComponent(segment);
    return decoded === '.' || decoded === '..' || /[\\/]/.test(decoded);
  })) throw new Error('A call path must not traverse or escape its service');
  return [pathname, at < 0 ? '' : path.slice(at)];
}

function operationMatches(operation: IndexedOperation, method: string, path: string): boolean {
  const [pathname] = pathParts(path);
  const requested = pathname.replace(placeholder, 'probe-value').split('/');
  const declared = operation.path.split('/');
  return operation.method === method && requested.length === declared.length
    && declared.every((part, index) => /^(?:\{[^}]+\}|:[\w]+)$/.test(part)
      ? Boolean(requested[index]) : part === requested[index]);
}

function checkPlaceholders(value: unknown, callNumber: number, path = false): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(placeholder)) {
      const reference = /^([1-9]\d*)\./.exec(match[1]!);
      if (reference && Number(reference[1]) >= callNumber) throw new Error('Answer placeholders must refer to an earlier call');
    }
    if (path && /\{[^{}]*\}/.test(value.replace(placeholder, ''))) throw new Error('Unknown or malformed placeholder');
  } else if (Array.isArray(value)) {
    for (const item of value) checkPlaceholders(item, callNumber);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) checkPlaceholders(item, callNumber);
  }
}

export function parseProbeCalls(calls: readonly string[], operations: readonly IndexedOperation[]): ProbeCall[] {
  if (!calls.length) throw new Error('Provide at least one persona call');
  return calls.map((call, index) => {
    const match = /^(\S+)\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(call.trim());
    if (!match) throw new Error('A call needs persona METHOD /path [json body]');
    const [, persona, rawMethod, path, json] = match;
    if (!probePersonas.some(name => name === persona)) throw new Error(`Unknown persona; choose ${probePersonas.join(', ')}`);
    const method = rawMethod!.toUpperCase();
    let body: unknown;
    if (json !== undefined) {
      try { body = JSON.parse(json); } catch { throw new Error('Broken JSON request body'); }
    }
    if (JSON.stringify(redactProbe({ path, body })) !== JSON.stringify({ path, body })) {
      throw new Error('Credentials belong to persona sessions, not probe requests');
    }
    checkPlaceholders(path, index + 1, true);
    checkPlaceholders(body, index + 1);
    const matches = operations.filter(operation => operationMatches(operation, method, path!));
    const operation = matches.sort((a, b) => a.path.localeCompare(b.path))[0];
    if (!operation) {
      const nearest = searchOperations(operations, `${method.toLowerCase()} ${path}`).nearestOperationIds
        ?? searchOperations(operations, `unknown ${method} ${path}`).nearestOperationIds;
      throw new Error(`No matching API operation. Nearest operationIds: ${nearest?.join(', ') ?? 'none'}`);
    }
    return { persona: persona as PersonaName, operationId: operation.operationId, method, path: path!,
      ...(json === undefined ? {} : { body }) };
  });
}

export interface ProbeFixtures { realm: string; space: string; zone: string }

function placeholderValue(key: string, fixtures: ProbeFixtures, answers: readonly ProbeAnswer[]): unknown {
  if (key === 'realm' || key === 'space' || key === 'zone') return fixtures[key];
  const [number, ...fields] = key.split('.');
  let value: unknown = answers[Number(number) - 1]?.answer;
  for (const field of fields) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, field)) throw new Error('Answer placeholder field is missing');
    value = (value as Record<string, unknown>)[field];
  }
  if (value === undefined) throw new Error('Answer placeholder field is missing');
  return value;
}

function interpolate(value: unknown, fixtures: ProbeFixtures, answers: readonly ProbeAnswer[]): unknown {
  if (typeof value === 'string') {
    const exact = /^\{([^{}]+)\}$/.exec(value);
    if (exact && [...value.matchAll(placeholder)].length === 1) return placeholderValue(exact[1]!, fixtures, answers);
    return value.replace(placeholder, (_token, key: string) => {
      const field = placeholderValue(key, fixtures, answers);
      if (field !== null && typeof field === 'object') throw new Error('An embedded placeholder needs a scalar value');
      return String(field);
    });
  }
  if (Array.isArray(value)) return value.map(item => interpolate(item, fixtures, answers));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, field]) => [key, interpolate(field, fixtures, answers)]));
  return value;
}

export function resolveProbeCall(call: ProbeCall, fixtures: ProbeFixtures, answers: readonly ProbeAnswer[]): ProbeCall {
  const [pathname, query] = pathParts(call.path);
  const replace = (pathId: boolean) => (_token: string, key: string) => {
    const field = placeholderValue(key, fixtures, answers);
    if (field === null || typeof field === 'object') throw new Error('A path placeholder needs a scalar value');
    const text = String(field);
    // API route IDs are UUIDs; bodies and query fields carry the full resource IRI.
    const id = pathId ? /^https:\/\/rezics\.com\/id\/([^/]+)$/.exec(text)?.[1] ?? text : text;
    return encodeURIComponent(id);
  };
  const path = pathname.replace(placeholder, replace(true)) + query.replace(placeholder, replace(false));
  pathParts(path);
  return { ...call, path, ...(Object.hasOwn(call, 'body') ? { body: interpolate(call.body, fixtures, answers) } : {}) };
}

export function formatProbeAnswer(call: ProbeAnswer, full = false): string {
  const safe = redactProbe(call) as ProbeAnswer;
  const json = JSON.stringify(safe.answer, null, 2).split('\n');
  const shown = full || json.length <= 60 ? json : [...json.slice(0, 59), '… (truncated; --full prints all)'];
  return [`${safe.persona} ${safe.method} ${safe.path} → ${safe.status} (${safe.elapsedSeconds.toFixed(3)}s)`,
    ...probeHeaders.filter(header => safe.headers[header] !== undefined).map(header => `${header}: ${safe.headers[header]}`),
    ...shown].join('\n');
}

export function probeRecord(result: ProbeResult): unknown {
  return redactProbe({ visibility: result.visibility,
    calls: result.calls.map(call => ({ persona: call.persona, ...recordAnswer(call) })) });
}

/** Resolve existing ancestors too, so a repository symlink cannot export a record. */
export function probeRecordPath(root: string, file: string): string {
  const target = resolve(root, file);
  const inside = (path: string) => {
    const local = relative(realpathSync(root), path);
    return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  };
  if (!inside(target)) throw new Error('Record file must be inside the repository');
  let ancestor = target;
  while (!existsSync(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Record file must be inside the repository');
    ancestor = dirname(ancestor);
  }
  if (ancestor !== root && !inside(realpathSync(ancestor))) throw new Error('Record file must be inside the repository');
  return target;
}
