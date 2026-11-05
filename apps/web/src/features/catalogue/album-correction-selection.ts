import { factLimit, factLocked, stageFact, type FactDraft, type FactsCurrent } from './subject-facts';

type SelectionChange =
  | { kind: 'stage'; read: FactsCurrent; property: string; source: string | null }
  | { kind: 'revise'; draft: FactDraft }
  | { kind: 'remove'; property: string; target?: FactDraft };

// Enumerable symbols survive the ordinary FactField and command/result spreads,
// while staying out of JSON and native statement payloads.
const incarnation = Symbol('album-correction');
type AlbumDraft = FactDraft & { [incarnation]?: number };
const touched = new WeakSet<FactDraft>();
let nextIdentity = 0;
/** Revisions retain the local row; staging the same property again creates a new target. */
export function albumDraftIdentity(draft: FactDraft): number {
  const holder = draft as AlbumDraft;
  return (holder[incarnation] ??= ++nextIdentity);
}

export function albumDraftPopulated(draft: FactDraft): boolean {
  const hasValue = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return Object.values(value).some(hasValue);
    return true;
  };
  const meaningful = (part: Pick<FactDraft['statement'], 'value'>) =>
    part.value.type !== 'value' || hasValue(part.value.content);
  const statement = draft.statement;
  return !!(
    touched.has(draft) ||
    draft.source ||
    meaningful(statement) ||
    statement.qualifiers?.some(meaningful) ||
    statement.references.some((reference) => reference.parts.some(meaningful))
  );
}

/** Only an unsubmitted draft can release a slot. Removing it never changes another field's intent. */
export function changeAlbumSelection(drafts: FactDraft[], change: SelectionChange): FactDraft[] {
  const property = change.kind === 'revise' ? change.draft.property : change.property;
  const current = drafts.find((draft) => draft.property === property);
  switch (change.kind) {
    case 'stage': {
      if (current || drafts.length >= factLimit) return drafts;
      const draft = stageFact(change.read, property, change.source);
      if (draft) albumDraftIdentity(draft);
      return draft ? [...drafts, draft] : drafts;
    }
    case 'remove':
      return current && !current.command && !factLocked(current) && (!change.target || change.target === current)
        ? drafts.filter((draft) => draft !== current)
        : drafts;
    case 'revise':
      // A delayed control event must not unseal a command whose delivery is now uncertain.
      if (
        !current ||
        factLocked(current) ||
        current.source !== change.draft.source ||
        albumDraftIdentity(current) !== albumDraftIdentity(change.draft)
      )
        return drafts;
      if (touched.has(current) || current.statement !== change.draft.statement) touched.add(change.draft);
      return drafts.map((draft) => (draft === current ? change.draft : draft));
  }
}
