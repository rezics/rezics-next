import {
  PROFILE_FORMAT,
  profileDigest,
  type PresentationProfile,
  type ProfileBaseTemplate,
  type ProfileRouteTemplate,
  type ProfileTypeTemplate,
} from '@rezics/composition';
import { templateViewNames, type Template } from './curate';
import { selectTemplate, selectionKey, type PresentationDraft } from './curate-view-editor-state';
import type { PageEditorData } from './editor-config';

export type KeyedTemplate = Exclude<Template, { scope: 'generic'; key: null }>;
export type KeyedTemplateEntry = ProfileBaseTemplate | ProfileTypeTemplate | ProfileRouteTemplate;
export type RemovalLifetime = { isCurrent(): boolean };
export type KeyedTemplateRemoval = {
  template: KeyedTemplate;
  entry: KeyedTemplateEntry;
  editors: Record<string, PageEditorData>;
  lifetime: RemovalLifetime;
};

export function keyedTemplateEntry(
  profile: PresentationProfile,
  template: KeyedTemplate,
): KeyedTemplateEntry | undefined {
  switch (template.scope) {
    case 'base':
      return profile.bases.find((entry) => entry.base === template.key);
    case 'type':
      return profile.types.find((entry) => entry.type === template.key);
    case 'route':
      return profile.routes.find((entry) => entry.route === template.key);
  }
}

function relevantEditors(draft: PresentationDraft, template: KeyedTemplate): Record<string, PageEditorData> {
  const editors: Record<string, PageEditorData> = {};
  for (const view of templateViewNames(draft.profile, template)) {
    const key = selectionKey({ template, view });
    const data = draft.editors[key];
    if (data !== undefined) editors[key] = data;
  }
  return editors;
}

/** Canonical digest of that keyed entry alone; object identity still wins for an unchanged draft. */
function keyedEntryIdentity(entry: KeyedTemplateEntry): string {
  return profileDigest({
    format: PROFILE_FORMAT,
    generic: { root: { props: {} }, content: [] },
    bases: 'base' in entry ? [entry] : [],
    types: 'type' in entry ? [entry] : [],
    routes: 'route' in entry ? [entry] : [],
  });
}

function sameKeyedEntry(reviewed: KeyedTemplateEntry, current: KeyedTemplateEntry): boolean {
  if (reviewed === current) return true;
  try {
    return keyedEntryIdentity(reviewed) === keyedEntryIdentity(current);
  } catch {
    return false;
  }
}

function sameEditors(reviewed: Record<string, PageEditorData>, current: Record<string, PageEditorData>): boolean {
  const keys = Object.keys(reviewed);
  if (keys.length !== Object.keys(current).length) return false;
  return keys.every(
    (key) => reviewed[key] === current[key] || JSON.stringify(reviewed[key]) === JSON.stringify(current[key]),
  );
}

export function reviewKeyedTemplateRemoval(
  draft: PresentationDraft,
  template: KeyedTemplate,
  lifetime: RemovalLifetime,
): KeyedTemplateRemoval | null {
  if (!lifetime.isCurrent()) return null;
  const entry = keyedTemplateEntry(draft.profile, template);
  return entry ? { template, entry, editors: relevantEditors(draft, template), lifetime } : null;
}

export function keyedTemplateRemovalApplies(draft: PresentationDraft, intention: KeyedTemplateRemoval): boolean {
  if (!intention.lifetime.isCurrent()) return false;
  const current = keyedTemplateEntry(draft.profile, intention.template);
  return !!current && sameKeyedEntry(intention.entry, current) && sameEditors(intention.editors, relevantEditors(draft, intention.template));
}

export function confirmKeyedTemplateRemoval(
  draft: PresentationDraft,
  intention: KeyedTemplateRemoval,
): PresentationDraft {
  return keyedTemplateRemovalApplies(draft, intention) ? removeKeyedTemplate(draft, intention.template) : draft;
}

/** Remove one local definition while keeping saved data and every other authored document intact. */
export function removeKeyedTemplate(draft: PresentationDraft, template: KeyedTemplate): PresentationDraft {
  const entry = keyedTemplateEntry(draft.profile, template);
  if (!entry) return draft;
  let { profile } = draft;
  switch (template.scope) {
    case 'base':
      profile = { ...profile, bases: profile.bases.filter((item) => item.base !== template.key) };
      break;
    case 'type':
      profile = { ...profile, types: profile.types.filter((item) => item.type !== template.key) };
      break;
    case 'route':
      profile = { ...profile, routes: profile.routes.filter((item) => item.route !== template.key) };
      break;
  }

  const editors = { ...draft.editors };
  for (const view of templateViewNames(draft.profile, template)) delete editors[selectionKey({ template, view })];
  const next = { ...draft, profile, editors };
  return draft.selection.template.scope === template.scope && draft.selection.template.key === template.key
    ? selectTemplate(next, { scope: 'generic', key: null })
    : next;
}
