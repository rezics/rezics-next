import type { PresentationProfile, View } from '@rezics/composition';
import type { CurationRead } from './curate-actions';
import { templateViewNames, withView, type Template } from './curate';
import { toComposition, type PageEditorData } from './editor-config';
import type { PublicationConfirmation } from './curation-publish';

export type CurationSnapshot = Extract<CurationRead, { ok: true }>;
export type ViewSelection = { template: Template; view: View };
export type PresentationDraft = {
  saved: CurationSnapshot;
  profile: PresentationProfile;
  selection: ViewSelection;
  editors: Record<string, PageEditorData>;
};

export function selectionKey({ template, view }: ViewSelection): string {
  return JSON.stringify([template.scope, template.key, view]);
}

export function presentationDraft(saved: CurationSnapshot): PresentationDraft {
  return {
    saved,
    profile: saved.profile,
    selection: { template: { scope: 'generic', key: null }, view: 'overview' },
    editors: {},
  };
}

export function selectTemplate(draft: PresentationDraft, template: Template): PresentationDraft {
  const views = templateViewNames(draft.profile, template);
  if (views.length === 0) return draft;
  return {
    ...draft,
    selection: { template, view: views.includes(draft.selection.view) ? draft.selection.view : 'overview' },
  };
}

/** Keep Puck's editing data too: blank language fields and editor IDs survive a view switch. */
export function editView(draft: PresentationDraft, selection: ViewSelection, data: PageEditorData): PresentationDraft {
  if (!templateViewNames(draft.profile, selection.template).includes(selection.view)) return draft;
  return {
    ...draft,
    profile: withView(draft.profile, selection.template, selection.view, toComposition(data)),
    editors: { ...draft.editors, [selectionKey(selection)]: data },
  };
}

export function hasDraftChanges(draft: PresentationDraft): boolean {
  return JSON.stringify(draft.profile) !== JSON.stringify(draft.saved.profile);
}

export function discardPresentationDraft(draft: PresentationDraft): PresentationDraft {
  const reset = presentationDraft(draft.saved);
  const views = templateViewNames(reset.profile, draft.selection.template);
  return views.includes(draft.selection.view) ? { ...reset, selection: draft.selection } : reset;
}

/** A confirmed retry advances its exact snapshot, while later per-view edits remain unpublished. */
export function confirmPresentationDraft(
  draft: PresentationDraft,
  { intent, result }: PublicationConfirmation,
): PresentationDraft {
  return {
    ...draft,
    saved: { ok: true, profile: intent.profile, digest: result.digest, head: result.head },
  };
}

/** The publication owner supplies the reviewed active snapshot, never an inferred publication receipt. */
export function reviewPresentationDraft(
  draft: PresentationDraft,
  active: CurationSnapshot,
  choice: 'keep' | 'discard',
): PresentationDraft {
  const reviewed = { ...draft, saved: active };
  return choice === 'keep' ? reviewed : discardPresentationDraft(reviewed);
}
