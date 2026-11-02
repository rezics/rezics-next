import { useAuthoringDeparture } from '../../threads/authoring-departure';
import { useEditorWorkspaceLifetime } from './editor-lifetime';
import { factChanged, type FactDraft } from './subject-facts';

/** Register with the existing page decision, independently of public reading admission. */
export function GameDraftDeparture({ dirty, pending }: { dirty: boolean; pending: boolean }) {
  const holder = useEditorWorkspaceLifetime();
  useAuthoringDeparture(
    () => holder.active() && (dirty || pending),
    pending,
    String(holder.generation),
    undefined,
    holder.retire,
  );
  return null;
}

/** Inclusion controls submission, not ownership of a changed private assertion. */
export function GameFactsDeparture({ drafts }: { drafts: readonly FactDraft[] }) {
  const unfinished = drafts.filter((draft) => !draft.result?.ok);
  return (
    <GameDraftDeparture
      dirty={unfinished.some((draft) => factChanged(draft))}
      pending={unfinished.some((draft) => !!draft.command)}
    />
  );
}
