import type { ComponentType, ReactNode } from 'react';
import type { EditionApi } from '../content-editions/contract';
import type { CreatorEditorCurrentRead, CreatorOffersCurrentRead } from './creator-offers';

/** Retirement is synchronous; publication follows the producer's existing notification schedule. */
export interface CheckoutCurrentVisit {
  publish(notify: () => void): void;
  subscribeRetirement(retire: () => void): () => void;
}

/** Navigation context only. Content owns the exact receipt, viewer and locale checks. */
export type CreatorEditionReviewProps = {
  token: string;
  editionId?: string | undefined;
  children: ReactNode;
};
export type CreatorEditionReview = {
  Origin: ComponentType<CreatorEditionReviewProps>;
  Panel: ComponentType<{ navigate(href: string): void }>;
};

/** Content supplies metadata only; protected bytes never enter the offer editor. */
export type CreatorEditionMetadataReader = Pick<EditionApi, 'readMetadata'>;

/** Bound by the served routes; standalone consumers have no native transport authority. */
export interface CreatorOfferReaders {
  list(input: { data: { cursor?: string } }): Promise<CreatorOffersCurrentRead>;
  editor(input: { data: { contentEditionId?: string } }): Promise<CreatorEditorCurrentRead>;
}
