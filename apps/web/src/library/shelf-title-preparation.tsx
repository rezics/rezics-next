import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { ShelfTitlePreparationReceipt } from './personal-library-server';

export class ShelfTitlePreparationSteps {
  private retryKey: string | null = null;

  async run(prepare: (key: string) => Promise<ShelfTitlePreparationReceipt>) {
    const key = this.retryKey ?? crypto.randomUUID();
    this.retryKey = key;
    const receipt = await prepare(key);
    this.retryKey = null;
    return receipt;
  }
}

export function ShelfTitlePreparation({
  isCurrent,
  prepare,
  refresh,
}: {
  isCurrent: () => boolean;
  prepare: (key: string) => Promise<ShelfTitlePreparationReceipt>;
  refresh: () => Promise<void>;
}) {
  const [steps] = useState(() => new ShelfTitlePreparationSteps());
  const [progress, setProgress] = useState<ShelfTitlePreparationReceipt | null>(null);
  const [failure, setFailure] = useState<'step' | 'page' | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function run(action: 'prepare' | 'refresh') {
    if (busyRef.current || !isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    let stage: 'step' | 'page' = 'page';
    try {
      if (action === 'prepare') {
        stage = 'step';
        const receipt = await steps.run(prepare);
        if (!isCurrent()) return;
        setProgress(receipt);
        if (receipt.installation === 'pending') return;
      }
      stage = 'page';
      await refresh();
    } catch {
      if (isCurrent()) setFailure(stage);
    } finally {
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <section aria-live="polite" className="flex min-w-0 flex-col items-start gap-3" data-shelf-title-state="preparing">
      <p role="status">
        {failure === 'step'
          ? m.library_title_prepare_uncertain()
          : failure === 'page'
            ? m.error_message()
            : progress?.installation === 'pending'
              ? m.library_title_prepare_progress({ prepared: progress.prepared })
              : m.library_title_order_preparing()}
      </p>
      <Button type="button" variant="outline" disabled={busy || !isCurrent()} onClick={() => void run('prepare')}>
        {busy
          ? m.library_title_prepare_running()
          : failure === 'step'
            ? m.library_title_prepare_retry()
            : progress?.installation === 'pending'
              ? m.library_title_prepare_next()
              : m.library_title_prepare_start()}
      </Button>
      {progress?.installation === 'installed' ? (
        <Button type="button" variant="outline" disabled={busy || !isCurrent()} onClick={() => void run('refresh')}>
          {m.library_window_retry()}
        </Button>
      ) : null}
    </section>
  );
}
