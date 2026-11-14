import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { recordingStatementDomId, recordingStatementFromHref } from './navigation';

type Selection = { owner: string; statement: string };
type Opener = Selection & { button: HTMLButtonElement };

/** Keep only a current statement identity; its public body always comes from the current visit. */
export function useRecordingFactSelection({
  scope,
  active,
  currentHref,
  subjectId,
  locale,
  hasStatement,
  unresolved,
}: {
  scope: number;
  active: () => boolean;
  currentHref?: string;
  subjectId: string;
  locale: string;
  hasStatement: (statement: string) => boolean;
  unresolved: boolean;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusIntent, setFocusIntent] = useState<Selection | null>(null);
  const seenHash = useRef<string | null>(null);
  const owner = JSON.stringify([scope, subjectId, locale]);
  const previousOwner = useRef(owner);
  const trigger = useRef<Opener | null>(null);
  const inspection = useRef<HTMLElement | null>(null);

  const selectedStatement = selection?.owner === owner ? selection.statement : undefined;

  const retireFocus = useCallback(() => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      (focused === trigger.current?.button || inspection.current?.contains(focused))
    )
      focused.blur();
    trigger.current = null;
  }, []);

  useLayoutEffect(() => {
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      setSelection(null);
      setFocusIntent(null);
    }
    return retireFocus;
  }, [owner, retireFocus]);

  useEffect(() => {
    const hash = currentHref ? new URL(currentHref, 'https://rezics.invalid').hash : '';
    if (hash === seenHash.current) return;
    seenHash.current = hash;
    const statement = recordingStatementFromHref(currentHref, subjectId, locale);
    if (!statement) return;
    setSelection({ owner, statement });
    setFocusIntent({ owner, statement });
  }, [currentHref, locale, owner, subjectId]);

  useLayoutEffect(() => {
    if (selectedStatement && !hasStatement(selectedStatement)) retireFocus();
    if (!focusIntent || focusIntent.owner !== owner || !active()) return;
    if (!hasStatement(focusIntent.statement)) {
      if (!unresolved) setFocusIntent(null);
      return;
    }

    const element = document.getElementById(recordingStatementDomId(focusIntent.statement));
    if (!element) return;
    const button = element.querySelector('button');
    if (button) trigger.current = { owner, statement: focusIntent.statement, button };
    const passive = document.activeElement === document.body || document.activeElement === document.documentElement;
    if (passive) element.focus();
    setFocusIntent(null);
  }, [active, focusIntent, hasStatement, unresolved, owner, retireFocus, selectedStatement]);

  const close = useCallback(() => {
    if (!selectedStatement || !active()) return;
    const opener = trigger.current;
    trigger.current = null;
    setSelection(null);
    setFocusIntent(null);
    if (
      opener?.owner === owner &&
      opener.statement === selectedStatement &&
      opener.button.isConnected &&
      hasStatement(selectedStatement)
    )
      opener.button.focus({ preventScroll: true });
  }, [active, hasStatement, owner, selectedStatement]);

  const inspect = useCallback(
    (statement: string, button: HTMLButtonElement) => {
      if (!active() || !hasStatement(statement)) return;
      if (selectedStatement === statement) {
        close();
      } else {
        trigger.current = { owner, statement, button };
        setSelection({ owner, statement });
        setFocusIntent(null);
      }
    },
    [active, close, hasStatement, owner, selectedStatement],
  );

  const restart = useCallback(() => {
    if (!active()) return;
    trigger.current = null;
    setSelection(null);
    setFocusIntent(null);
  }, [active]);

  return {
    selectedStatement,
    inspect,
    close,
    restart,
    inspection,
  };
}
