import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { KnowledgeOwnedNotebook, KnowledgeOutlinePage } from './navigation.ts';

export const knowledgeTemplateKinds = ['inspiration', 'arc', 'scene'] as const;
export type KnowledgeTemplateKind = (typeof knowledgeTemplateKinds)[number];
export type KnowledgeAuthoringDraft = Readonly<{
  title: string;
  language: string | null;
  body: DocumentSnapshot;
  licence: string;
}>;
export type KnowledgeAuthoringTemplate = Readonly<{
  kind: KnowledgeTemplateKind;
  title: string;
  body: string;
}>;
export type KnowledgePlacementChoice = 'new-notebook' | 'existing-notebook';
export type KnowledgeAuthoringDestination = Readonly<{
  notebookId: string;
  notebookTitle: string;
  subjectId: string;
  parentPlacementId: string | null;
  parentTitle: string | null;
  structureRevisionId: string;
}>;

const defaultLicence = 'LicenseRef-rezics-terms';

/** Templates are editable starting text. They are not native document types. */
export function knowledgeAuthoringTemplateDraft(
  template: KnowledgeAuthoringTemplate,
  language: string | null,
): KnowledgeAuthoringDraft {
  return {
    title: template.title,
    language,
    body: fromPlainText(template.body, 'blocks'),
    licence: defaultLicence,
  };
}

export function knowledgeAuthoringBlankDraft(title: string, language: string | null): KnowledgeAuthoringDraft {
  return {
    title,
    language,
    body: fromPlainText('', 'blocks'),
    licence: defaultLicence,
  };
}

/** The inventory row is the only notebook authority: no route-derived IDs and no hydration. */
export function knowledgeAuthoringNotebookSelection(row: KnowledgeOwnedNotebook): KnowledgeOwnedNotebook {
  return {
    notebookId: row.notebookId,
    subjectId: row.subjectId,
    title: row.title,
    structureRevisionId: row.structureRevisionId,
    createdAt: row.createdAt,
  };
}

/** Destination identity comes from the last observed outline page plus the selected notebook row. */
export function knowledgeAuthoringDestination(
  notebook: KnowledgeOwnedNotebook,
  outline: KnowledgeOutlinePage,
  parentTitle: string | null,
): KnowledgeAuthoringDestination | null {
  if (outline.notebookId !== notebook.notebookId) return null;
  return {
    notebookId: notebook.notebookId,
    notebookTitle: notebook.title,
    subjectId: notebook.subjectId,
    parentPlacementId: outline.parentPlacementId,
    parentTitle: outline.parentPlacementId === null ? null : parentTitle,
    structureRevisionId: outline.structureRevisionId,
  };
}

export function sameKnowledgeAuthoringDestination(
  left: KnowledgeAuthoringDestination | null,
  right: KnowledgeAuthoringDestination | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.notebookId === right.notebookId &&
    left.subjectId === right.subjectId &&
    left.parentPlacementId === right.parentPlacementId &&
    left.structureRevisionId === right.structureRevisionId
  );
}
