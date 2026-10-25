import { createHash } from 'node:crypto';
import type { DataType } from '@rezics/definitions';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
export type { Violation } from '@rezics/definitions/validate';
import { derivedId, routeOf } from '../route/route.ts';

export type Value = { type: 'value'; content: unknown } | { type: 'somevalue' } | { type: 'novalue' };
export type Snak = { property: { id: string; data_type: DataType }; value: Value };
export type Reference = { parts: Snak[]; hash: string };
export type Statement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: { id: string; data_type: DataType };
  value: Value;
  qualifiers: Snak[];
  references: Reference[];
  rezics: { release: string; revision: number };
};
export type Item = {
  id: string;
  type: string;
  revision: number;
  release: string;
  context: string;
  resolution: Record<string, never>;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  statements: Record<string, Statement[]>;
};
export type Fact = {
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};
export type FactRow = {
  kind: Fact['kind'];
  language: string | null;
  property: string | null;
  statement_id: string | null;
  operation: Fact['operation'];
  body: unknown;
  fact_revision?: number | null;
  fact_release?: string | null;
};
export class SubjectInputError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super('Subject input is invalid');
    this.name = 'SubjectInputError';
    this.violations = violations.slice(0, 16);
  }
}

export const SLOT_NS = 'c30d6caa-d9e8-4108-a42a-35701219e8ec';
const STATEMENT_NS = '9f44e74c-b77c-47aa-96d0-b7a4aa330182';
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function itemFacts(subjectId: string, input: unknown, _type?: string): Fact[] {
  const route = routeOf(subjectId);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  const { violations, terms, aliasTerms, drafts } = checkSubjectStructure(input);
  if (violations.length) throw new SubjectInputError(violations);
  const facts: Fact[] = [];
  const put = (
    kind: Fact['kind'],
    key: string,
    seq: number,
    body: unknown,
    language: string | null,
    property: string | null,
    statementId: string | null,
  ) =>
    facts.push({
      slot_id: derivedId(SLOT_NS, `${subjectId}\n${kind}\n${key}`, route),
      log_seq: seq,
      operation: 'assert',
      kind,
      language,
      property,
      statement_id: statementId,
      body,
    });
  for (const t of terms) put(t.kind, t.language, 1, t.body, t.language, null, null);
  const aliasSeq = new Map<string, number>();
  for (const t of aliasTerms) {
    const seq = (aliasSeq.get(t.language) ?? 0) + 1;
    aliasSeq.set(t.language, seq);
    put('alias', t.language, seq, t.body, t.language, null, null);
  }
  for (const group of drafts)
    group.entries.forEach((entry, i) => {
      const seq = i + 1;
      const slotId = derivedId(SLOT_NS, `${subjectId}\nstatement\n${group.property}`, route);
      const statementId = derivedId(STATEMENT_NS, `${slotId}\n${seq}`, route);
      const bare = (snak: unknown) => {
        const s = snak as { property: string; value: unknown };
        return { property: s.property, value: s.value };
      };
      const references = entry.references.map((ref) => ({ parts: ref.parts.map(bare) }));
      put(
        'statement',
        group.property,
        seq,
        { rank: entry.rank, value: entry.value, qualifiers: entry.qualifiers.map(bare), references },
        null,
        group.property,
        statementId,
      );
    });
  return facts;
}

export function resolveItem(
  subjectId: string,
  rows: readonly FactRow[],
  type: string,
  dataTypes: Readonly<Record<string, DataType>>,
  metadata: { revision: number; release: string; context: string },
): Item {
  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const aliases = new Map<string, string[]>();
  const statements = new Map<string, Statement[]>();
  for (const row of rows) {
    if (row.operation === 'expand') continue;
    if (row.kind === 'label' || row.kind === 'description') {
      const target = row.kind === 'label' ? labels : descriptions;
      if (row.operation === 'retract') delete target[row.language!];
      else target[row.language!] = row.body as string;
    } else if (row.kind === 'alias') {
      const list = aliases.get(row.language!) ?? [];
      const index = list.indexOf(row.body as string);
      if (row.operation === 'retract') {
        if (index >= 0) list.splice(index, 1);
      } else if (index < 0) list.push(row.body as string);
      aliases.set(row.language!, list);
    } else {
      const property = row.property!;
      const list = statements.get(property) ?? [];
      const index = list.findIndex((statement) => statement.id === row.statement_id);
      if (row.operation === 'retract') {
        if (index >= 0) list.splice(index, 1);
      } else {
        const body = row.body as {
          rank: Statement['rank'];
          value: Value;
          qualifiers: { property: string; value: Value }[];
          references: { parts: { property: string; value: Value }[] }[];
        };
        const snak = (entry: { property: string; value: Value }): Snak => ({
          property: { id: entry.property, data_type: dataTypes[entry.property]! },
          value: entry.value,
        });
        const refs = body.references.map((ref) => ({
          parts: ref.parts.map(snak),
          hash: createHash('sha256').update(canonical(ref.parts)).digest('hex'),
        }));
        const resolved: Statement = {
          id: row.statement_id!,
          rank: body.rank,
          property: { id: property, data_type: dataTypes[property]! },
          value: body.value,
          qualifiers: body.qualifiers.map(snak),
          references: refs,
          rezics: {
            revision: row.fact_revision ?? metadata.revision,
            release: row.fact_release ?? metadata.release,
          },
        };
        if (index >= 0) list.splice(index, 1);
        list.push(resolved);
      }
      statements.set(property, list);
    }
  }
  return {
    id: subjectId,
    type,
    ...metadata,
    resolution: {},
    labels,
    descriptions,
    aliases: Object.fromEntries([...aliases].filter(([, values]) => values.length)),
    statements: Object.fromEntries([...statements].filter(([, values]) => values.length)),
  };
}
