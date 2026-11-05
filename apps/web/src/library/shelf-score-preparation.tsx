import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { ShelfScorePreparationReceipt } from './personal-library-server';

export class ShelfScorePreparationSteps {
  private retryKey: string | null = null;

  async run(prepare: (key: string) => Promise<ShelfScorePreparationReceipt>) {
    const key = this.retryKey ?? crypto.randomUUID();
    this.retryKey = key;
    const receipt = await prepare(key);
    this.retryKey = receipt.installation === 'pending' ? null : key;
    return receipt;
  }
}

export function ShelfScorePreparation({
  isCurrent,
  prepare,
  refresh,
}: {
  isCurrent: () => boolean;
  prepare: (key: string) => Promise<ShelfScorePreparationReceipt>;
  refresh: () => Promise<void>;
}) {
  const [steps] = useState(() => new ShelfScorePreparationSteps());
  const [progress, setProgress] = useState<ShelfScorePreparationReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const advance = async () => {
    if (busyRef.current || !isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    let receipt: ShelfScorePreparationReceipt;
    try {
      receipt = await steps.run(prepare);
    } catch {
      if (isCurrent()) setFailed(true);
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
      return;
    }
    if (!isCurrent()) {
      busyRef.current = false;
      return;
    }
    setProgress(receipt);
    try {
      if (receipt.installation === 'installed') await refresh();
    } finally {
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <section aria-live="polite" className="flex min-w-0 flex-col items-start gap-3" data-shelf-score-state="preparing">
      <p role="status">
        {failed
          ? m.library_score_prepare_uncertain()
          : progress?.installation === 'installed'
            ? m.library_score_prepare_ready()
            : progress
              ? m.library_score_prepare_progress({ prepared: progress.prepared })
              : m.library_score_order_preparing()}
      </p>
      {progress?.installation === 'installed' ? null : (
        <Button type="button" variant="outline" className="min-h-11" disabled={busy || !isCurrent()} onClick={advance}>
          {busy
            ? m.library_score_prepare_running()
            : failed
              ? m.library_score_prepare_retry()
              : progress
                ? m.library_score_prepare_next()
                : m.library_score_prepare_start()}
        </Button>
      )}
    </section>
  );
}
