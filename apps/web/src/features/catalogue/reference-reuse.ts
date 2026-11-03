import type { Release } from '@rezics/definitions';
import { checkStatementInput } from '@rezics/definitions/validate';
import type { SnakInput, StatementInput } from './statement-editor';
import { factHolder, factWritable, type FactDraft } from './subject-facts';

export const reuseTargetLimit = 16;
export const referenceGroupLimit = 16;
export type ReferenceGroup = { parts: SnakInput[] };
export type ReuseRefusal =
  | 'locked'
  | 'unknown'
  | 'withdrawn'
  | 'limit'
  | 'definition'
  | 'constraint'
  | 'missing'
  | 'source'
  | 'self';
export type ReusePreview = { ok: true; next: StatementInput } | { ok: false; reason: ReuseRefusal };
export type ReuseSource = {
  holder: string;
  property: string;
  groupIndex: number;
  snapshot: ReferenceGroup;
};

export function cloneReferenceGroup(group: ReferenceGroup): ReferenceGroup {
  return structuredClone({ parts: group.parts });
}

export function referenceGroupFingerprint(group: ReferenceGroup | undefined): string {
  return JSON.stringify(group?.parts ?? null);
}

export function completeReferenceGroup(group: ReferenceGroup | undefined): group is ReferenceGroup {
  return !!group && group.parts.length >= 1 && group.parts.length <= referenceGroupLimit;
}

export function reuseSourcePresent(draft: FactDraft | undefined, source: ReuseSource): boolean {
  if (!draft || factHolder(draft) !== source.holder || draft.property !== source.property) return false;
  return (
    referenceGroupFingerprint(draft.statement.references[source.groupIndex]) ===
    referenceGroupFingerprint(source.snapshot)
  );
}

function partAdmitted(part: SnakInput, release: Release): boolean {
  const definition = release.properties[part.property.id];
  return !!definition && !definition.relation;
}

export function previewReuse(
  target: FactDraft | undefined,
  group: ReferenceGroup,
  release: Release,
  sourceHolder?: string,
): ReusePreview {
  if (!target) return { ok: false, reason: 'missing' };
  if (sourceHolder && factHolder(target) === sourceHolder) return { ok: false, reason: 'self' };
  if (target.reuseBlocked) return { ok: false, reason: target.reuseBlocked };
  if (!factWritable(target)) return { ok: false, reason: 'locked' };
  if (!completeReferenceGroup(group)) return { ok: false, reason: 'constraint' };
  if (target.statement.references.length >= referenceGroupLimit) return { ok: false, reason: 'limit' };
  if (group.parts.some((part) => !partAdmitted(part, release))) return { ok: false, reason: 'definition' };
  const copy = cloneReferenceGroup(group);
  const next: StatementInput = {
    ...target.statement,
    references: [...target.statement.references, copy],
  };
  const index = next.references.length - 1;
  const errors = checkStatementInput(next, release, { allowUnknownReferences: true }).violations.filter((error) =>
    error.pointer.startsWith(`/statement/references/${index}`),
  );
  if (errors.some((error) => error.code === 'unsupported' || error.code === 'unknown_field'))
    return { ok: false, reason: 'definition' };
  if (errors.length) return { ok: false, reason: 'constraint' };
  return { ok: true, next };
}

export type ReuseCapture = {
  source: string;
  targets: Record<string, { statement: string; writable: boolean }>;
};

export function captureReuse(source: ReuseSource, drafts: FactDraft[]): ReuseCapture {
  return {
    source: referenceGroupFingerprint(source.snapshot),
    targets: Object.fromEntries(
      drafts.map((draft) => [
        factHolder(draft),
        { statement: JSON.stringify(draft.statement), writable: factWritable(draft) },
      ]),
    ),
  };
}

export function reuseIsStale(
  source: ReuseSource,
  drafts: FactDraft[],
  selected: readonly string[],
  capture: ReuseCapture,
): boolean {
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  if (referenceGroupFingerprint(origin?.statement.references[source.groupIndex]) !== capture.source) return true;
  if (referenceGroupFingerprint(source.snapshot) !== capture.source) return true;
  for (const holder of selected) {
    const draft = drafts.find((item) => factHolder(item) === holder);
    const before = capture.targets[holder];
    if (!draft || !before) return true;
    if (JSON.stringify(draft.statement) !== before.statement || factWritable(draft) !== before.writable) return true;
  }
  return false;
}

export function applyReuse(
  drafts: FactDraft[],
  source: ReuseSource,
  selected: readonly string[],
  release: Release,
): {
  drafts: FactDraft[];
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
} {
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  if (!reuseSourcePresent(origin, source) || !completeReferenceGroup(origin?.statement.references[source.groupIndex])) {
    return {
      drafts,
      applied: [],
      refused: selected.map((holder) => ({
        holder,
        property: drafts.find((draft) => factHolder(draft) === holder)?.property ?? holder,
        reason: 'source' as const,
      })),
    };
  }
  const group = origin!.statement.references[source.groupIndex]!;
  const applied: { holder: string; property: string; index: number }[] = [];
  const refused: { holder: string; property: string; reason: ReuseRefusal }[] = [];
  const chosen = [...new Set(selected)].slice(0, reuseTargetLimit);
  const next = drafts.map((draft) => {
    const holder = factHolder(draft);
    if (!chosen.includes(holder)) return draft;
    const preview = previewReuse(draft, group, release, source.holder);
    if (!preview.ok) {
      refused.push({ holder, property: draft.property, reason: preview.reason });
      return draft;
    }
    applied.push({ holder, property: draft.property, index: preview.next.references.length - 1 });
    return { ...draft, statement: preview.next, command: undefined, result: undefined };
  });
  for (const holder of chosen) {
    if (applied.some((item) => item.holder === holder) || refused.some((item) => item.holder === holder)) continue;
    refused.push({ holder, property: holder, reason: 'missing' });
  }
  return { drafts: next, applied, refused };
}
