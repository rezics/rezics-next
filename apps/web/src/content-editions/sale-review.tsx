import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { KernelClient } from '@rezics/client';
import type {
  CreatorEditionMetadataReader,
  CreatorEditionReview,
  CreatorEditionReviewProps,
} from '../checkout/reader-origin';
import { useSession } from '../session/query';
import { localizeHref } from '../paraglide/runtime.js';
import { createNativeEditionApi } from './edition-api';
import { CreatorEditionOriginPanel } from './creator-edition-origin-panel';
import {
  creatorEditionOriginReturnHref,
  readCreatorEditionOrigin,
  restartCreatorEditionOrigin,
  retireCreatorEditionOrigin,
  type CreatorEditionOriginResolution,
} from './creator-edition-origin';

/** Only the metadata reader is offered to checkout, never a protected-body reader. */
export function creatorSaleEditionReader(client: KernelClient): CreatorEditionMetadataReader {
  const api = createNativeEditionApi(client);
  return { readMetadata: api.readMetadata };
}

const ReviewOrigin = createContext<{ token: string; resolution: CreatorEditionOriginResolution | null } | null>(null);

/** Keep receipt lifetime mounted across preparing and unavailable offer readers. */
function CreatorSaleEditionOrigin({ token, editionId, children }: CreatorEditionReviewProps) {
  const session = useSession();
  const [resolution, setResolution] = useState<CreatorEditionOriginResolution | null>(null);
  const priorCredential = useRef<string | null>(null);
  const sawCredential = useRef(false);
  useEffect(() => {
    if (!sawCredential.current) {
      if (session.csrfToken) {
        priorCredential.current = session.csrfToken;
        sawCredential.current = true;
      }
      return;
    }
    if (priorCredential.current !== session.csrfToken) {
      retireCreatorEditionOrigin(token);
      priorCredential.current = session.csrfToken;
      setResolution({ kind: 'lost', reason: 'account' });
    }
  }, [session.csrfToken, token]);
  useEffect(() => {
    if (!token) {
      setResolution(null);
      return;
    }
    if (session.state === 'unknown') return;
    if (!editionId) {
      retireCreatorEditionOrigin(token);
      setResolution({ kind: 'lost', reason: 'edition' });
      return;
    }
    setResolution(readCreatorEditionOrigin(token, session.subject, editionId));
  }, [token, editionId, session.state, session.subject]);
  return <ReviewOrigin.Provider value={{ token, resolution }}>{children}</ReviewOrigin.Provider>;
}

function CreatorSaleEditionReviewPanel({ navigate }: { navigate(href: string): void }) {
  const origin = useContext(ReviewOrigin);
  const session = useSession();
  const resolution = origin?.resolution;
  if (!origin || !resolution) return null;
  const { token } = origin;
  const currentReceipt = () => {
    if (resolution.kind !== 'current') return null;
    const current = readCreatorEditionOrigin(token, session.subject, resolution.receipt.editionId);
    return current.kind === 'current' ? current.receipt : null;
  };
  const restart = () => {
    if (resolution.kind === 'current') {
      const current = currentReceipt();
      const receipt = current && restartCreatorEditionOrigin(token);
      if (receipt) {
        navigate(creatorEditionOriginReturnHref(receipt));
        return;
      }
    }
    navigate(localizeHref('/editions'));
  };
  return (
    <CreatorEditionOriginPanel
      resolution={resolution}
      {...(resolution.kind === 'current'
        ? {
            onReturn: () => {
              const receipt = currentReceipt();
              if (receipt) navigate(creatorEditionOriginReturnHref(receipt));
            },
            editionId: resolution.receipt.editionId,
          }
        : {})}
      onRestart={restart}
    />
  );
}

/** Static region components only; no private observation is stored in composition. */
export const creatorSaleEditionReview = {
  Origin: CreatorSaleEditionOrigin,
  Panel: CreatorSaleEditionReviewPanel,
} satisfies CreatorEditionReview;
