import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { CreatedReader } from './create-subject';
import { addonBase, addonFields, addonType } from './addon-profile';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import type { StatementInput } from './statement-editor';
import { factHolder, type FactDraft } from './subject-facts';

export type AddonReuseState = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

export type AddonReviewedBase = {
  statement: StatementInput;
  subject?: Pick<SubjectRead['subject'], 'id' | 'type' | 'labels'> | undefined;
};

/** Independent initial facts only. The base workspace does not export a FactDraft holder. */
export function addonFactDrafts(facts: readonly { key: string; statement: StatementInput }[]): FactDraft[] {
  return facts.map((row) => ({
    holder: row.key,
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function addonFactsFromDrafts(
  drafts: FactDraft[],
  previous: readonly { key: string; statement: StatementInput }[],
): { key: string; statement: StatementInput }[] {
  const known = new Set(previous.map((row) => row.key));
  return drafts.flatMap((draft) => {
    const key = factHolder(draft);
    return known.has(key) ? [{ key, statement: draft.statement }] : [];
  });
}

export function captureAddonReuse(
  facts: readonly { key: string; statement: StatementInput }[],
  key: string,
  index: number,
): AddonReuseState | null {
  const origin = facts.find((row) => row.key === key);
  const group = origin?.statement.references[index];
  if (!origin || !group) return null;
  const drafts = addonFactDrafts(facts);
  const source = {
    holder: key,
    property: origin.statement.property.id,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return { source, selected: [], capture: captureReuse(source, drafts), applied: [], refused: [] };
}

export function applyAddonReuse(
  facts: readonly { key: string; statement: StatementInput }[],
  reuse: AddonReuseState,
  release: Release,
) {
  const result = applyReuse(addonFactDrafts(facts), reuse.source, reuse.selected, release);
  return {
    facts: addonFactsFromDrafts(result.drafts, facts),
    applied: result.applied,
    refused: result.refused,
  };
}

export function refreshAddonReuse(
  facts: readonly { key: string; statement: StatementInput }[],
  reuse: AddonReuseState,
): AddonReuseState | null {
  const origin = facts.find((row) => row.key === reuse.source.holder);
  const group = origin?.statement.references[reuse.source.groupIndex];
  if (!origin || !group) return null;
  const source = {
    ...reuse.source,
    property: origin.statement.property.id,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    ...reuse,
    source,
    capture: captureReuse(source, addonFactDrafts(facts)),
    applied: [],
    refused: [],
  };
}

export function addonAdmitCreatedReader(reader: CreatedReader, id: string): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (!identity || identity.id !== id || identity.type !== addonType) return { state: 'stale' };
  return reader;
}

export function addonStructuredParts(statements: Record<string, StatementInput[]> | undefined): number {
  let count = 0;
  for (const rows of Object.values(statements ?? {})) {
    for (const statement of rows) {
      count += 1 + (statement.qualifiers?.length ?? 0);
      for (const group of statement.references) count += group.parts.length;
    }
  }
  return count;
}

export function addonIncludedBase(
  statements: Record<string, StatementInput[]> | undefined,
  subject: Pick<SubjectRead['subject'], 'id' | 'type' | 'labels'> | undefined,
): AddonReviewedBase | undefined {
  const statement = statements?.[addonBase]?.[0];
  if (!statement) return;
  const target =
    statement.value.type === 'value' && typeof statement.value.content === 'string' ? statement.value.content : '';
  return { statement, subject: subject?.id === target ? subject : undefined };
}

export function addonUnsupportedProperties(
  release: Release,
  statements: Record<string, StatementInput[]> | undefined,
): string[] {
  const admitted = addonFields(release);
  return Object.keys(statements ?? {}).filter((property) => !admitted.includes(property));
}
