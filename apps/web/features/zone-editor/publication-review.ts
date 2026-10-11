import type { ZoneAuthoringClient, ZoneNavigationClient, ZoneThemeClient, WriteResult } from './api.ts';
import type { PublicationChoice, EditorState } from './model.ts';
import { canPublish, publicationChoice } from './model.ts';
import type { SiteLink } from './navigation.ts';
import { readPresentation, type StructuralThemeChoice, type ZonePresentationBaseline } from './theme.ts';

export interface SavedPublicationSelection {
  zoneHead: string;
  navigationRevision: string;
  navigationId: string;
  navigation: SiteLink[];
  presentationNavigation: ZonePresentationBaseline['navigation'];
  theme: StructuralThemeChoice;
}

export interface PublicationReview {
  selection: SavedPublicationSelection;
  confirmed: boolean;
}

export function stagePublicationReview(selection: SavedPublicationSelection): PublicationReview {
  return { selection, confirmed: false };
}

export function confirmPublicationReview(review: PublicationReview): PublicationReview {
  return { ...review, confirmed: true };
}

/** Read the exact saved cuts before a stale publish can be retried. */
export async function readSavedPublicationSelection(zoneId: string, actingSubject: string, clients: {
  authoring: Pick<ZoneAuthoringClient, 'readHeads'>;
  navigation: Pick<ZoneNavigationClient, 'readNavigation' | 'continueNavigation'>;
  theme: Pick<ZoneThemeClient, 'readConfiguration'>;
}): Promise<WriteResult<SavedPublicationSelection>> {
  const [heads, navigation, configuration] = await Promise.all([
    clients.authoring.readHeads(zoneId, actingSubject),
    clients.navigation.readNavigation(zoneId, actingSubject),
    clients.theme.readConfiguration(zoneId, actingSubject),
  ]);
  if (!heads.ok) return heads;
  if (!navigation.ok) return navigation;
  if (!configuration.ok) return configuration;

  const links = [...navigation.data.links];
  let after = navigation.data.after;
  let complete = navigation.data.complete;
  const cursors = new Set<string>();
  while (!complete) {
    if (!after || cursors.has(after)) return { ok: false, failure: 'unavailable' };
    cursors.add(after);
    const page = await clients.navigation.continueNavigation(zoneId, actingSubject, {
      head: navigation.data.head,
      after,
    });
    if (!page.ok) return page;
    if (page.data.head !== navigation.data.head || page.data.navigation !== navigation.data.navigation) {
      return { ok: false, failure: 'stale', currentHead: heads.data.zoneHead };
    }
    links.push(...page.data.links);
    after = page.data.after;
    complete = page.data.complete;
  }

  const presentation = readPresentation(configuration.data.configuration);
  if (presentation.kind !== 'ready') return { ok: false, failure: 'unavailable' };
  if (configuration.data.revision !== heads.data.zoneHead
    || navigation.data.head !== heads.data.navigationRevision
    || (navigation.data.zoneHead !== null && navigation.data.zoneHead !== heads.data.zoneHead)) {
    return { ok: false, failure: 'stale', currentHead: heads.data.zoneHead };
  }
  return {
    ok: true,
    data: {
      zoneHead: heads.data.zoneHead,
      navigationRevision: heads.data.navigationRevision,
      navigationId: navigation.data.navigation,
      navigation: links,
      presentationNavigation: presentation.presentation.navigation,
      theme: presentation.choice,
    },
  };
}

/** Build a new publish choice only from a selection the author has already reviewed. */
export function reviewedPublicationChoice(state: EditorState, zoneIri: string,
  review: PublicationReview): PublicationChoice | null {
  if (!review.confirmed) return null;
  if (!canPublish(state)) return null;
  const page = publicationChoice(state, zoneIri);
  if (!page) return null;
  return {
    ...page,
    zoneHead: review.selection.zoneHead,
    navigationRevision: review.selection.navigationRevision,
    routesRevision: review.selection.navigationRevision,
  };
}
