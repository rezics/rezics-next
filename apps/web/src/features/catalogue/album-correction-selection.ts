import { factLimit, factLocked, stageFact, type FactDraft, type FactsCurrent } from './subject-facts';

type SelectionChange =
  | { kind: 'stage'; read: FactsCurrent; property: string; source: string | null }
  | { kind: 'revise'; draft: FactDraft }
  | { kind: 'remove'; property: string };

/** Only an unsubmitted draft can release a slot. Removing it never changes another field's intent. */
export function changeAlbumSelection(drafts: FactDraft[], change: SelectionChange): FactDraft[] {
  const property = change.kind === 'revise' ? change.draft.property : change.property;
  const current = drafts.find((draft) => draft.property === property);
  switch (change.kind) {
    case 'stage': {
      if (current || drafts.length >= factLimit) return drafts;
      const draft = stageFact(change.read, property, change.source);
      return draft ? [...drafts, draft] : drafts;
    }
    case 'remove':
      return current && !current.command ? drafts.filter((draft) => draft !== current) : drafts;
    case 'revise':
      // A delayed control event must not unseal a command whose delivery is now uncertain.
      if (!current || factLocked(current) || current.source !== change.draft.source) return drafts;
      return drafts.map((draft) => (draft === current ? change.draft : draft));
  }
}
