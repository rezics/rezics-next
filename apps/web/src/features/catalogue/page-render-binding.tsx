import type { ComponentType } from 'react';
import { createElement } from 'react';
import { pageDataBinding } from './page-data-binding';
import { mangaObservedOrigin } from './manga-public-visit';
import { conceptPublicReturnHref } from './source-concept-explorer/public-visit';
import { WorkTagReading } from './work-tag-reading/entry';
import { RecipeCurrentVisitReturn } from './recipe-current-visit-view';
import { AlbumCurrentVisitReturn } from './album-current-visit';
import { CharacterAssociationBridge } from './character-public-reading/bridge';
import { releaseVisitReturn } from './release-fidelity/navigation';
import { creditReturn } from './credit-inspection/navigation';
import { workFranchiseFragment, workFranchiseReturn } from './work-franchise-reading/navigation';
import { mangaOccurrenceFromFragment } from './manga-reader/navigation';
import {
  consumeGameClassificationReturn,
  gameClassificationReturn,
  gameClassificationReturnLimit,
  gameClassificationReturnStorageKey,
} from './game-current-visit-descriptor';
import { zoneVisitReturn } from '../../zones/visit';
import { storyArcPublicOrigin } from './story-arc-public-visit';
import {
  parseRecipeCurrentReturn,
  recipeCorrectionHref,
  recipeCurrentReturnState,
  recipePublicSubjectHref,
} from './recipe-current-visit';
import { albumCurrentVisitSourceAddress, createAlbumCurrentVisitLink } from './album-current-visit-model';
import type { SemanticPageComponent, SemanticRenderPort } from '../pages/semantic-render-port';

function component<P extends object>(value: ComponentType<P>): SemanticPageComponent<P> {
  return (props) => createElement(value, props as P);
}

/** Concrete catalogue implementations installed by the Subject page's React composition boundary. */
export const pageRenderBinding: SemanticRenderPort = {
  components: {
    workTagReading: component(WorkTagReading),
    recipeCurrentVisitReturn: component(RecipeCurrentVisitReturn),
    albumCurrentVisitReturn: component(AlbumCurrentVisitReturn),
    characterAssociationBridge: component(CharacterAssociationBridge),
  },
  definitions: pageDataBinding.definitions,
  frames: {
    mangaObservedOrigin,
    conceptPublicReturnHref,
  },
  subjects: {
    ...pageDataBinding.subjects,
    storyArcPublicOrigin,
    parseRecipeCurrentReturn,
    recipeCurrentReturnState,
    recipePublicSubjectHref,
    recipeCorrectionHref,
    albumCurrentVisitSourceAddress,
    createAlbumCurrentVisitLink,
  },
  navigation: {
    zoneVisitReturn,
    releaseVisitReturn,
    creditReturn,
    workFranchiseReturn,
    workFranchiseFragment,
    mangaOccurrenceFromFragment,
    gameClassificationReturn,
    gameClassificationReturnLimit,
    gameClassificationReturnStorageKey,
    consumeGameClassificationReturn,
  },
};
