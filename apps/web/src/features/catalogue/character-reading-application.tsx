import {
  useCharacterReadingSlots,
  type CharacterConnectionRead,
  type CharacterConnectionWindow,
} from './character-reading-port';

export {
  CHARACTER_WORK_PAGE_LIMIT,
  CharacterReadingProvider,
  CharacterReadingSlotsContext,
  characterWorkStream,
  characterWorkRows,
  characterRelationRelated,
  characterWorkNotes,
  useCharacterReadingSlots,
  useCharacterPage,
  type CharacterReadingSlots,
  type CharacterPageSlot,
  type CharacterReadSlot,
  type CharacterNavigationSlot,
  type CharacterPresentationSlot,
  type CharacterPage,
  type CharacterPageItem,
  type CharacterPageSection,
  type CharacterWorkKind,
  type CharacterWorkRow,
  type CharacterConnectionStream,
  type CharacterConnectionSection,
  type CharacterConnectionAddress,
  type CharacterConnectionVisit,
  type CharacterConnectionRead,
  type CharacterConnectionWindow,
  type CharacterConnectionSnapshot,
  type CharacterConnectionPageState,
  type CharacterReturnWindow,
  type CharacterCreditVisit,
  type CharacterCreditAssertion,
  type CharacterRelated,
  type CharacterCoverListProps,
  type CharacterCandidateValueProps,
  type CharacterSpoilerGateProps,
  type Snak,
  type Stmt,
  type PageLink,
  type LinkProps,
} from './character-reading-port';

export { CharacterPublicReading, type CharacterAssociations } from './character-public-reading/view';
export { CharacterAssociationBridge, CharacterAssociationBinding } from './character-public-reading/bridge';
export { CharacterWorkRows } from './character-work-visit/view';
export {
  creditVisit,
  creditAssertion,
  creditCorrection,
  creditRelated,
  type CreditVisit,
  type CreditAssertion,
  type CreditCorrection,
} from './credit-inspection/model';
export {
  creditReturn,
  creditWindowHref,
  creditLocator,
  creditReturnMatches,
  type CreditReturn,
} from './credit-inspection/navigation';
export { creditDestinationHref } from './credit-inspection/destinations';
export { CreditInspectionAction, CreditVisitReturn, type CreditReturnItem } from './credit-inspection/return';

export function useCharacterReadSlot() {
  return useCharacterReadingSlots().read;
}

export function useCharacterNavigation() {
  return useCharacterReadingSlots().navigation;
}

export function useCharacterPresentation() {
  return useCharacterReadingSlots().presentation;
}

export type CharacterWindowBinding = {
  source: object;
  window: CharacterConnectionWindow;
};

export type CharacterAssociationRead = {
  source: object;
  viewer: string | null;
  read?: CharacterConnectionRead;
};
