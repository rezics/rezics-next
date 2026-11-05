import type { Candidate, CandidateSelection } from './candidates';

export type CandidateDraft = { selection: CandidateSelection[]; omitted: string[] };

/** A page is not the slot: keep edits and add newly disclosed public selections on reread. */
export function refreshCandidateDraft(
  draft: CandidateDraft | undefined,
  selected: CandidateSelection[],
): CandidateDraft {
  if (!draft) return { selection: selected, omitted: [] };
  return {
    ...draft,
    selection: [
      ...draft.selection,
      ...selected.filter(
        (entry) =>
          !draft.omitted.includes(entry.candidate) &&
          !draft.selection.some((known) => known.candidate === entry.candidate),
      ),
    ],
  };
}

export function editCandidateDraft(
  draft: CandidateDraft,
  candidate: string,
  rank: CandidateSelection['rank'] | null,
): CandidateDraft {
  const selection = draft.selection.filter((entry) => entry.candidate !== candidate);
  return {
    selection: rank ? [...selection, { candidate, rank }] : selection,
    omitted: rank ? draft.omitted.filter((id) => id !== candidate) : [...new Set([...draft.omitted, candidate])],
  };
}

export function candidateCanSelect(candidate: Candidate): boolean {
  return candidate.decision === 'accepted' && candidate.retracted === null && candidate.rank !== 'deprecated';
}
