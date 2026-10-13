import { readCompleteZoneNavigation, type ZoneAuthoringClient, type ZoneNavigationClient, type ZoneThemeClient, type WriteResult } from './api.ts';
import type { PublicationChoice, EditorState } from './model.ts';
import { canPublish, preparedHomeDocument, publicationChoice } from './model.ts';
import type { SiteLink } from './navigation.ts';
import { readPresentation, type StructuralThemeChoice, type ZonePresentationBaseline } from './theme.ts';

export interface SavedPublicationSelection {
  homeDocument: string;
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
    readCompleteZoneNavigation(zoneId, actingSubject, clients.navigation),
    clients.theme.readConfiguration(zoneId, actingSubject),
  ]);
  if (!heads.ok) return heads;
  if (!navigation.ok) return navigation;
  if (!configuration.ok) return configuration;

  const homeDocument = preparedHomeDocument(configuration.data.configuration);
  if (!homeDocument) return { ok: false, failure: 'unavailable' };

  if (configuration.data.revision !== heads.data.zoneHead
    || navigation.data.head !== heads.data.navigationRevision
    || navigation.data.zoneHead !== heads.data.zoneHead) {
    return { ok: false, failure: 'stale', currentHead: heads.data.zoneHead };
  }
  const savedPresentation = readPresentation(configuration.data.configuration);
  const effective = configuration.data.effectivePresentation;
  if (savedPresentation.kind === 'absent' && effective && effective.revision !== heads.data.zoneHead) {
    return { ok: false, failure: 'stale', currentHead: heads.data.zoneHead };
  }
  const presentation = savedPresentation.kind === 'absent' && effective
    ? readPresentation({ presentation: effective.presentation }) : savedPresentation;
  if (presentation.kind !== 'ready') return { ok: false, failure: 'unavailable' };
  return {
    ok: true,
    data: {
      homeDocument,
      zoneHead: heads.data.zoneHead,
      navigationRevision: heads.data.navigationRevision,
      navigationId: navigation.data.navigation,
      navigation: navigation.data.links,
      presentationNavigation: presentation.presentation.navigation,
      theme: presentation.choice,
    },
  };
}

/** Build a new publish choice only from a selection the author has already reviewed. */
export function reviewedPublicationChoice(state: EditorState,
  review: PublicationReview): PublicationChoice | null {
  if (!review.confirmed) return null;
  if (!canPublish(state)) return null;
  if (state.homeDocument !== review.selection.homeDocument) return null;
  const page = publicationChoice(state);
  if (!page) return null;
  return {
    ...page,
    zoneHead: review.selection.zoneHead,
    navigationRevision: review.selection.navigationRevision,
    routesRevision: review.selection.navigationRevision,
  };
}
