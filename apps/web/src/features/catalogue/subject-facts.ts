import type { KernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  correctionProperty,
  proposalInput,
  proposeStatement,
  statementInput,
  validateStatement,
  type EditorRead,
  type ProposalCommand,
  type ProposalResult,
  type StatementInput,
} from './statement-editor';

export const factLimit = 12;
export type FactsCurrent = Extract<EditorRead, { ok: true }>;
export type FactResult = ProposalResult | { ok: false; reason: 'uncertain' };
export type FactCommand = ProposalCommand & { session?: string | undefined };
export type FactDraft = {
  property: string;
  source: string | null;
  baseline: StatementInput | null;
  statement: StatementInput;
  included: boolean;
  submission?: { statement: StatementInput; release: Release } | undefined;
  command?: FactCommand | undefined;
  result?: FactResult | undefined;
};
export type FactsTransport = {
  read: () => Promise<EditorRead>;
  propose: (command: FactCommand) => Promise<FactResult>;
};

/** Effective emitted order and datatypes group the form; no vertical-specific field inventory. */
export function factGroups(read: FactsCurrent) {
  const groups: Record<'text' | 'time' | 'quantity', string[]> = { text: [], time: [], quantity: [] };
  for (const property of read.release.types[read.public.subject.type]?.properties ?? []) {
    if (!correctionProperty(read.release, read.public.subject.type, property)) continue;
    const datatype = read.release.properties[property]!.datatype;
    groups[datatype === 'time' || datatype === 'quantity' ? datatype : 'text'].push(property);
  }
  return groups;
}

export function stageFact(read: FactsCurrent, property: string, source: string | null): FactDraft | null {
  if (!correctionProperty(read.release, read.public.subject.type, property)) return null;
  const selected = source ? read.public.subject.statements[property]?.find((item) => item.id === source) : null;
  if (source && !selected) return null;
  const baseline = selected ? statementInput(selected) : null;
  return {
    property,
    source,
    baseline,
    included: true,
    statement: baseline
      ? structuredClone(baseline)
      : {
          property: { id: property },
          value: { type: 'value', content: '' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? '';
}
export function factChanged(draft: FactDraft): boolean {
  return draft.baseline === null || canonical(draft.baseline) !== canonical(draft.statement);
}
export function factLocked(draft: FactDraft): boolean {
  return (
    !!draft.result && (draft.result.ok || draft.result.reason === 'uncertain' || draft.result.reason === 'unavailable')
  );
}

export function factCommandInput(value: unknown): FactCommand | { invalid: true } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
  const { session, ...command } = value as Record<string, unknown>;
  if (session !== undefined && (typeof session !== 'string' || session.length > 16384)) return { invalid: true };
  const parsed = proposalInput(command);
  return 'invalid' in parsed ? parsed : { ...parsed, ...(typeof session === 'string' ? { session } : {}) };
}

/** Same generated native call as the single-field editor; delivery uncertainty is explicit here. */
export async function proposeFact(
  client: KernelClient,
  authorization: string,
  command: FactCommand,
): Promise<FactResult> {
  let uncertain = false;
  const result = await proposeStatement(client, authorization, command, {
    session: command.session,
    uncertain: () => {
      uncertain = true;
    },
  });
  return uncertain ? { ok: false, reason: 'uncertain' } : result;
}

/** Seal only an explicitly included changed set. Successes cannot be replayed by a later submit. */
export function sealFacts(id: string, release: Release, drafts: FactDraft[]): FactDraft[] {
  const pending = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  if (pending.length > factLimit || new Set(drafts.map((draft) => draft.property)).size !== drafts.length)
    throw new Error('Invalid changed-field set');
  return drafts.map((draft) => {
    if (!pending.includes(draft) || draft.command) return draft;
    const statement = structuredClone(draft.statement);
    const submission = { statement, release };
    const errors = validateStatement(draft.statement, release);
    if (errors.length) return { ...draft, submission, result: { ok: false, reason: 'invalid', errors } };
    return {
      ...draft,
      submission,
      result: undefined,
      command: { id, key: crypto.randomUUID(), statement },
    };
  });
}

/** Independent per-field outcomes; the caller stores every sealed key before starting any request. */
export async function sendFacts(
  drafts: FactDraft[],
  propose: FactsTransport['propose'],
  onResult: (property: string, result: FactResult) => void,
): Promise<void> {
  const pending = drafts.filter((draft) => draft.included && draft.command && !draft.result?.ok);
  if (pending.length > factLimit) throw new Error('Invalid changed-field set');
  await Promise.all(
    pending.map(async (draft) => {
      let result: FactResult;
      try {
        result = await propose(draft.command!);
      } catch {
        result = { ok: false, reason: 'uncertain' };
      }
      onResult(draft.property, result);
    }),
  );
}
