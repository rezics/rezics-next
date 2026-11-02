import { VIEWS, type CompositionDocument, type PresentationProfile, type View } from '@rezics/composition';
import { overviewOf, viewOf, type CompanionViewSource, type Template } from './curate';

export type CompanionAddChoice = {
  view: View | '';
  source: CompanionViewSource | '';
};

export type CompanionResetIntent = {
  view: View;
  document: CompositionDocument;
};

export const emptyCompanionAdd: CompanionAddChoice = { view: '', source: '' };

/** Missing local companions of a generic, base or type template, in native view order. */
export function availableCompanionViews(profile: PresentationProfile, template: Template): View[] {
  return template.scope === 'route'
    ? []
    : VIEWS.filter((candidate) => candidate !== 'overview' && viewOf(profile, template, candidate) === undefined);
}

export function canResetCompanionView(profile: PresentationProfile, template: Template, view: View): boolean {
  return template.scope !== 'route' && view !== 'overview' && viewOf(profile, template, view) !== undefined;
}

/** Keep a still-missing view and explicit source; drop only the stale part of the choice. */
export function admitCompanionAdd(
  choice: CompanionAddChoice,
  profile: PresentationProfile,
  template: Template,
): CompanionAddChoice {
  const available = availableCompanionViews(profile, template);
  const view = choice.view !== '' && available.includes(choice.view) ? choice.view : '';
  const source =
    choice.source === 'empty'
      ? 'empty'
      : choice.source === 'overview' && overviewOf(profile, template) !== undefined
        ? 'overview'
        : '';
  return view === choice.view && source === choice.source ? choice : { view, source };
}

export function companionResetIntent(
  profile: PresentationProfile,
  template: Template,
  view: View,
): CompanionResetIntent | null {
  if (!canResetCompanionView(profile, template, view)) return null;
  return { view, document: viewOf(profile, template, view)! };
}

/** Confirm only the reviewed override document; sibling identity-preserving edits keep the intent. */
export function admitCompanionReset(
  intent: CompanionResetIntent | null,
  profile: PresentationProfile,
  template: Template,
): CompanionResetIntent | null {
  if (!intent || !canResetCompanionView(profile, template, intent.view)) return null;
  return viewOf(profile, template, intent.view) === intent.document ? intent : null;
}
