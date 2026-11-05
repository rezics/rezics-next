import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import type { CreatorEditionOriginReceipt, CreatorEditionOriginResolution } from './creator-edition-origin';

type OriginPanelProps = {
  resolution: CreatorEditionOriginResolution;
  occurrence?: 'checking' | 'present' | 'missing';
  onReturn?: () => void;
  onRestart?: () => void;
  editionId?: string | null;
  sourceRevisionId?: string | null;
  children?: ReactNode;
};

export function CreatorEditionOriginPanel({
  resolution,
  occurrence,
  onReturn,
  onRestart,
  editionId,
  sourceRevisionId,
  children,
}: OriginPanelProps) {
  const isCurrent = resolution.kind === 'current';
  const text = !isCurrent
    ? m.creator_edition_origin_lost()
    : occurrence === 'checking'
      ? m.creator_edition_origin_checking()
      : occurrence === 'present'
        ? m.creator_edition_origin_present()
        : occurrence === 'missing'
          ? m.creator_edition_origin_missing()
          : m.creator_edition_origin_available();
  return (
    <section
      aria-label={m.creator_edition_origin_heading()}
      className="my-4 rounded-lg border border-current/20 bg-current/[0.03] p-4"
      data-creator-edition-origin={isCurrent ? 'current' : 'lost'}
    >
      <h2 className="text-lg font-semibold">{m.creator_edition_origin_heading()}</h2>
      <p aria-live="polite" className="mt-2">
        {text}
      </p>
      {editionId || sourceRevisionId ? (
        <dl className="mt-3 grid min-w-0 gap-2 text-sm sm:grid-cols-2">
          {editionId ? (
            <div className="min-w-0">
              <dt className="text-muted-foreground">{m.creator_edition_origin_edition()}</dt>
              <dd className="break-all font-mono select-all">{editionId}</dd>
            </div>
          ) : null}
          {sourceRevisionId ? (
            <div className="min-w-0">
              <dt className="text-muted-foreground">{m.creator_edition_origin_source_revision()}</dt>
              <dd className="break-all font-mono select-all">{sourceRevisionId}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        {isCurrent && onReturn ? (
          <button className="min-h-11 rounded-md border px-4 py-2 font-medium" onClick={onReturn} type="button">
            {m.creator_edition_origin_return()}
          </button>
        ) : null}
        {onRestart ? (
          <button className="min-h-11 rounded-md border px-4 py-2 font-medium" onClick={onRestart} type="button">
            {m.creator_edition_origin_restart()}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function originReceiptHasEdition(
  receipt: CreatorEditionOriginReceipt,
  editionId: string | null | undefined,
): boolean {
  return Boolean(receipt.editionId && editionId && receipt.editionId === editionId);
}
