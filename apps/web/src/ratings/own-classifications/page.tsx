import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { classificationAddressKey, classificationPair, indexOwnClassifications } from './inventory';
import type { ClassificationCommands } from './editor';
import { ClassificationInspection, ClassificationAvailability, OwnState, classificationControl } from './inspection';
import { classificationActionAllowed } from './intent';
import type { ClassificationFrontier, OwnClassificationsPage, OwnClassificationsState } from './types';

const control = classificationControl;

/** Native page order and original keys survive summary movement and selected promotion. */
export function OwnClassificationsWorkspace({
  state,
  page,
  frontier,
  locale,
  isCurrent,
  onRetry,
  onNext,
  previous,
  focusHeading = false,
  commands,
}: {
  state: OwnClassificationsState;
  page: OwnClassificationsPage | null;
  frontier: ClassificationFrontier;
  locale: string;
  isCurrent: () => boolean;
  onRetry: (frontier: ClassificationFrontier) => Promise<unknown>;
  onNext: (frontier: ClassificationFrontier, keyboard?: boolean) => void;
  previous?: { cursor: string | null } | null;
  focusHeading?: boolean;
  commands?: ClassificationCommands | undefined;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const [selection, select] = useState<{ generation: number; key: string | null } | null>(null);
  const protection = useRef<{ generation: number; key: string | null; protected: boolean } | null>(null);
  const focusFrame = useRef<number | null>(null);
  const focusVersion = useRef(0);
  function cancelFocus() {
    focusVersion.current++;
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
  }
  const active = isCurrent();
  const address = classificationAddressKey(frontier);
  const latest = useRef({ page, state, active, locale, address, generation: 0 });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelFocus();
    };
  }, []);
  if (
    latest.current.page !== page ||
    latest.current.state !== state ||
    latest.current.active !== active ||
    latest.current.locale !== locale ||
    latest.current.address !== address
  )
    latest.current = { page, state, active, locale, address, generation: latest.current.generation + 1 };
  const generation = latest.current.generation;
  const current = () =>
    mounted.current && latest.current.generation === generation && latest.current.active && isCurrent();
  let admitted: OwnClassificationsPage | null = state === 'ready' && current() ? page : null;
  let index: ReturnType<typeof indexOwnClassifications> | null = null;
  if (admitted) {
    try {
      index = indexOwnClassifications(admitted, frontier);
    } catch {
      admitted = null;
    }
  }
  const selectedKey =
    selection?.generation === generation
      ? selection.key
      : commands && frontier.selected
        ? classificationPair(frontier.selected)
        : null;
  const selected = admitted && selectedKey ? index?.get(selectedKey) : null;
  const opener = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  const liveSelection = useRef(selectedKey);
  liveSelection.current = selectedKey;
  const selectionCurrent = () => current() && liveSelection.current === selectedKey;
  const protectedEditor = () =>
    protection.current?.generation === generation &&
    protection.current.key === selectedKey &&
    protection.current.protected;
  useLayoutEffect(() => cancelFocus, [generation]);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (focusHeading && current() && document.activeElement === document.body) heading.current?.focus();
  }, [focusHeading]);
  const moving = useRef<{ generation: number; token: symbol } | null>(null);
  async function changeSelection(key: string | null) {
    if (!selectionCurrent() || moving.current?.generation === generation || key === selectedKey) return;
    const token = Symbol();
    moving.current = { generation, token };
    const returnOpener = opener.current;
    // The existing departure owner distinguishes selection from leaving the private visit.
    const decision = selected ? commands?.confirmMovement?.current : null;
    const leave = decision
      ? await decision({
          kind: 'selection',
          returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        })
      : !protectedEditor();
    if (moving.current?.token === token) moving.current = null;
    if (!leave || !selectionCurrent()) return;
    cancelFocus();
    select({ generation, key });
    if (key === null && returnOpener) {
      const version = focusVersion.current;
      focusFrame.current = requestAnimationFrame(() => {
        if (focusVersion.current !== version) return;
        focusFrame.current = null;
        if (current() && returnOpener.isConnected) returnOpener.focus({ preventScroll: true });
      });
    }
  }
  async function move(cursor: string | null, keyboard: boolean) {
    if (!current() || moving.current?.generation === generation) return;
    const token = Symbol();
    moving.current = { generation, token };
    const decision = selected ? commands?.confirmMovement?.current : null;
    const leave = decision ? await decision() : !protectedEditor();
    if (moving.current?.token === token) moving.current = null;
    if (!leave || !current()) return;
    const target = {
      cursor,
      selected:
        frontier.selected ??
        (selected ? { subjectId: selected.subjectId, associationId: selected.associationId } : null),
    };
    commands?.retire?.();
    onNext(target, keyboard);
  }
  const feedback = () => {
    if (state === 'signed-out') return m.own_classifications_signed_out({}, options);
    if (state === 'denied') return m.own_classifications_denied({}, options);
    if (state === 'invalid-address') return m.own_classifications_invalid({}, options);
    if (state === 'stale-continuation') return m.own_classifications_stale({}, options);
    if (state === 'moved-home') return m.own_classifications_moved({}, options);
    if (state === 'preparing') return m.subject_classification_assessment_preparing({}, options);
    return m.own_classifications_unavailable({}, options);
  };
  return (
    <main className="mx-auto min-w-0 max-w-4xl space-y-6 p-4">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        {m.own_classifications_title({}, options)}
      </h1>
      <p>{m.own_classifications_intro({}, options)}</p>
      {!admitted ? (
        <div role="status" className="space-y-3">
          <p>{feedback()}</p>
          {state === 'unavailable' && current() ? (
            <Button className={control} onClick={() => current() && void onRetry(frontier)}>
              {m.own_classifications_retry({}, options)}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p role="status">{m.own_classifications_coverage({}, options)}</p>
          {admitted.items.length === 0 ? (
            <p role="status">
              {admitted.next === null
                ? m.own_classifications_empty({}, options)
                : m.own_classifications_sparse({}, options)}
            </p>
          ) : null}
          <ol key={generation} className="space-y-3" aria-label={m.own_classifications_title({}, options)}>
            {admitted.items.map((row) => {
              const pair = classificationPair(row);
              const expanded = selected === row;
              return (
                <li key={pair} className="min-w-0 space-y-3 rounded-xl border p-4 wrap-anywhere">
                  {row.state === 'available' ? (
                    <>
                      <p className="font-semibold">{row.subject.label ?? m.subject_value_unlabelled({}, options)}</p>
                      <p>{row.target.label ?? m.subject_value_unlabelled({}, options)}</p>
                    </>
                  ) : (
                    <p>{m.own_classifications_withheld({}, options)}</p>
                  )}
                  <OwnState row={row} locale={locale} />
                  {!expanded ? <ClassificationAvailability row={row} locale={locale} /> : null}
                  {row.state === 'available' || (commands && classificationActionAllowed(row, 'DELETE')) ? (
                    <Button
                      className={control}
                      variant="outline"
                      ref={expanded ? opener : undefined}
                      aria-expanded={expanded}
                      aria-controls={expanded ? detailId : undefined}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && expanded && !event.defaultPrevented) {
                          event.preventDefault();
                          event.stopPropagation();
                          void changeSelection(null);
                        }
                      }}
                      onClick={() => {
                        void changeSelection(pair);
                      }}
                    >
                      {m.subject_classification_assessment_inspect({}, options)}
                    </Button>
                  ) : null}
                  {expanded ? (
                    <ClassificationInspection
                      key={`${generation}:${pair}`}
                      id={detailId}
                      row={row}
                      commands={commands}
                      locale={locale}
                      isCurrent={selectionCurrent}
                      refresh={() => onRetry(frontier)}
                      onClose={() => void changeSelection(null)}
                      onProtection={(value) => {
                        if (selectionCurrent()) protection.current = { generation, key: selectedKey, protected: value };
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div key={`navigation:${generation}`} className="flex flex-wrap gap-3">
            {previous ? (
              <Button className={control} onClick={(event) => void move(previous.cursor, event.detail === 0)}>
                {m.library_collections_previous({}, options)}
              </Button>
            ) : null}
            {frontier.cursor !== null ? (
              <Button className={control} onClick={(event) => void move(null, event.detail === 0)}>
                {m.library_collections_first_page({}, options)}
              </Button>
            ) : null}
            {admitted.next !== null ? (
              <Button className={control} onClick={(event) => void move(admitted.next, event.detail === 0)}>
                {m.own_classifications_next({}, options)}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </main>
  );
}
