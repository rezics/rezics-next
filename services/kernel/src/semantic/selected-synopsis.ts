import type { Item, Snak, Statement } from './item.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';

export type SelectedSynopsisInput = {
  statement: string;
  document: string;
  digest: string;
  language: string;
  context: string;
  release: string;
  realm?: string;
  pageRelease?: string;
};
export type SelectedSynopsisResult =
  | { kind: 'matched'; fact: Statement; context: string; release: string }
  | { kind: 'changed' | 'missing' | 'unsupported' | 'unavailable' };

/** HTTP transport only. The original comparison operands never enter the result. */
export function parseSelectedSynopsis(value: string): SelectedSynopsisInput | undefined {
  if (new TextEncoder().encode(value).byteLength > 2048) return;
  let input: unknown;
  try { input = JSON.parse(value); } catch { return; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const row = input as Record<string, unknown>;
  const keys = ['statement', 'document', 'digest', 'language', 'context', 'release', 'realm', 'pageRelease'];
  if (Object.keys(row).some((key) => !keys.includes(key))) return;
  for (const key of keys.slice(0, 6)) if (typeof row[key] !== 'string' || !row[key]) return;
  for (const key of ['realm', 'pageRelease']) if (row[key] !== undefined && typeof row[key] !== 'string') return;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(row.statement)) || !uuid.test(String(row.document)) || !uuid.test(String(row.context)) ||
      !/^[0-9a-f]{64}$/.test(String(row.digest)) || String(row.language).length > 35) return;
  return row as SelectedSynopsisInput;
}

export function selectedSynopsisFact(subject: Item, input: SelectedSynopsisInput): Statement | undefined {
  if (subject.context !== GLOBAL_CONTEXT || input.context !== subject.context || input.realm ||
      subject.release !== input.release) return;
  const statements = subject.statements['schema:abstract'] ?? [];
  const rank = statements.some((row) => row.rank === 'preferred') ? 'preferred' : 'normal';
  return statements.find((row) => {
    if (row.id !== input.statement || row.rank !== rank || row.property.data_type !== 'document' || row.value.type !== 'value') return false;
    const value = row.value.content as { document?: string; digest?: string; language?: string };
    return value.document === input.document && value.digest === input.digest && value.language === input.language;
  });
}

/** Redact every locator, including locator-valued qualifier and reference parts. */
export function redactSynopsisFact(fact: Statement): Statement {
  const redact = <T extends Snak>(snak: T): T =>
    snak.property.data_type === 'document' || snak.property.data_type === 'media'
      ? { ...snak, value: { type: 'somevalue' } } : snak;
  return { ...redact(fact), qualifiers: fact.qualifiers.map(redact),
    references: fact.references.map((reference) => ({ ...reference, parts: reference.parts.map(redact) })) };
}
