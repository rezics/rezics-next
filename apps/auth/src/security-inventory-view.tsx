import { loadInventory, type ConsentOperationBoundary } from './security-inventory';
import { ConnectedApplicationReview } from './connected-application-review-view';
import { OwnedApplicationReview } from './owned-application-review-view';

export type InventorySource = typeof loadInventory;

/** One bounded page per independent native inventory; ownership never follows consent. */
export function SecurityInventory({
  source = loadInventory,
  preflight = false,
  operation,
  onSessionEnded,
  lifetime,
}: {
  source?: InventorySource;
  preflight?: boolean;
  operation?: ConsentOperationBoundary;
  onSessionEnded?: () => void;
  lifetime?: AbortSignal;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <OwnedApplicationReview source={source} preflight={preflight} {...(lifetime ? { lifetime } : {})} />
      <ConnectedApplicationReview
        source={source}
        preflight={preflight}
        {...(operation ? { operation } : {})}
        {...(onSessionEnded ? { onSessionEnded } : {})}
        {...(lifetime ? { lifetime } : {})}
      />
    </div>
  );
}
