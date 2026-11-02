import { templateViewNames, type Template } from './curate';
import { selectTemplate, selectionKey, type PresentationDraft } from './curate-view-editor-state';

export type KeyedTemplate = Exclude<Template, { scope: 'generic'; key: null }>;

/** Remove one local definition while keeping saved data and every other authored document intact. */
export function removeKeyedTemplate(draft: PresentationDraft, template: KeyedTemplate): PresentationDraft {
  let profile = draft.profile;
  switch (template.scope) {
    case 'base':
      if (!profile.bases.some((entry) => entry.base === template.key)) return draft;
      profile = { ...profile, bases: profile.bases.filter((entry) => entry.base !== template.key) };
      break;
    case 'type':
      if (!profile.types.some((entry) => entry.type === template.key)) return draft;
      profile = { ...profile, types: profile.types.filter((entry) => entry.type !== template.key) };
      break;
    case 'route':
      if (!profile.routes.some((entry) => entry.route === template.key)) return draft;
      profile = { ...profile, routes: profile.routes.filter((entry) => entry.route !== template.key) };
      break;
  }

  const editors = { ...draft.editors };
  for (const view of templateViewNames(draft.profile, template)) delete editors[selectionKey({ template, view })];
  const next = { ...draft, profile, editors };
  return draft.selection.template.scope === template.scope && draft.selection.template.key === template.key
    ? selectTemplate(next, { scope: 'generic', key: null })
    : next;
}
