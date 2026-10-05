import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { RealmDirectoryWorker } from '../../../../services/main/src/modules/realm-directory/worker.ts';
import { DiscoveryRefreshWorker } from '../../../../services/main/src/modules/discovery/refresh.ts';
import { RankingBuildWorker } from '../../../../services/main/src/modules/recommendation/build-worker.ts';
import { NotificationProducerWorker } from '../../../../services/main/src/modules/notification-producers/producer.ts';
import { NotificationDigestWorker } from '../../../../services/main/src/modules/notification/digest.ts';
import { NotificationDeliveryWorker } from '../../../../services/main/src/modules/notification/delivery-worker.ts';
import { FeedRefreshWorker } from '../../../../services/main/src/modules/feed/refresh.ts';
import { ReadRankingProjection } from '../../../../services/main/src/modules/rankings/projection.ts';
import { SerialStatisticsProjection } from '../../../../services/main/src/modules/work/serial-projection.ts';
import { ZoneBrowseProjection } from '../../../../services/main/src/modules/zone-browse/store.ts';
import { RealmPolicyRecoveryWorker } from '../../../../services/main/src/modules/access/realm-management-recovery.ts';
import { MediaScreenWorker } from '../../../../services/main/src/modules/media-screen/worker.ts';
import { MediaRenditionWorker } from '../../../../services/main/src/modules/media-rendition/worker.ts';
import { OccurrenceLabelWorker } from '../../../../services/main/src/modules/structure/label-index-worker.ts';
import { LibraryImportRetentionWorker } from '../../../../services/main/src/modules/library-import/retention-worker.ts';
import { VerificationCorrectionWorker } from '../../../../services/main/src/modules/verification/correction-delivery.ts';
import { PostgresRateLimitStore } from '../../../../services/main/src/modules/rate-limit/store.ts';

const background = new AsyncLocalStorage<boolean>();

export function isForegroundOperation(): boolean {
  return background.getStore() !== true;
}

export function runBackgroundOperation<T>(operation: () => T): T {
  return background.run(true, operation);
}

/** Mark scheduling boundaries, including lazy request startup and follow-up nudges.
 * Explicit ticks remain measurable. All graph, SQL and observer counters share
 * this context, so another owner reached after an await retains attribution. */
function attributeScheduler<T extends object, K extends keyof T>(prototype: T, key: K): void {
  const schedule = prototype[key] as (this: T) => void;
  prototype[key] = function (this: T) {
    return runBackgroundOperation(() => schedule.call(this));
  } as T[K];
}

// Module initialization installs each boundary once per test process. Counters
// import this module before constructing their apps; no scheduler is disabled.
for (const prototype of [
  RealmDirectoryWorker.prototype,
  DiscoveryRefreshWorker.prototype,
  RankingBuildWorker.prototype,
  NotificationProducerWorker.prototype,
  NotificationDigestWorker.prototype,
  NotificationDeliveryWorker.prototype,
  FeedRefreshWorker.prototype,
  ReadRankingProjection.prototype,
  SerialStatisticsProjection.prototype,
  ZoneBrowseProjection.prototype,
  RealmPolicyRecoveryWorker.prototype,
  MediaScreenWorker.prototype,
  MediaRenditionWorker.prototype,
  OccurrenceLabelWorker.prototype,
  LibraryImportRetentionWorker.prototype,
  VerificationCorrectionWorker.prototype,
]) {
  attributeScheduler(prototype, 'start');
}
attributeScheduler(RealmDirectoryWorker.prototype, 'nudge');
attributeScheduler(PostgresRateLimitStore.prototype, 'startExpirySweep');

/** Real owner pool; count checkout attempts, including failures and callback calls. */
export class CountingPool extends Pool {
  checkouts = 0;

  override connect = ((...args: unknown[]) => {
    if (isForegroundOperation()) this.checkouts++;
    return (Pool.prototype.connect as (...values: unknown[]) => unknown).apply(this, args);
  }) as Pool['connect'];
}
