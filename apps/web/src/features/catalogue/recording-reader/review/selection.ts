import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { recordingStatementDomId, recordingStatementFromHref } from './navigation';

type Selection = { scope: number; statement: string };
type FocusIntent = { scope: number; statement: string; target: 'inspection' | 'statement' | 'trigger' };

/** Keep only a current statement identity; its public body always comes from the current visit. */
export function useRecordingFactSelection({
  scope,
  active,
  currentHref,
  subjectId,
  locale,
  hasStatement,
  loading,
}: {
  scope: number;
  active: () => boolean;
  currentHref?: string;
  subjectId: string;
  locale: string;
  hasStatement: (statement: string) => boolean;
  loading: boolean;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusIntent, setFocusIntent] = useState<FocusIntent | null>(null);
  const seenHash = useRef<string | null>(null);
  const previousScope = useRef(scope);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const inspectionHeading = useRef<HTMLHeadingElement | null>(null);

  const selectedStatement = selection?.scope === scope ? selection.statement : undefined;

  useLayoutEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    trigger.current = null;
    setSelection(null);
    setFocusIntent(null);
  }, [scope]);

  useEffect(() => {
    const hash = currentHref ? new URL(currentHref, 'https://rezics.invalid').hash : '';
    if (hash === seenHash.current) return;
    seenHash.current = hash;
    const statement = recordingStatementFromHref(currentHref, subjectId, locale);
    if (!statement) return;
    setSelection({ scope, statement });
    setFocusIntent({ scope, statement, target: 'statement' });
  }, [currentHref, locale, scope, subjectId]);

  useLayoutEffect(() => {
    if (!focusIntent || focusIntent.scope !== scope || !active()) return;
    if (!hasStatement(focusIntent.statement)) {
      if (!loading) setFocusIntent(null);
      return;
    }

    const element =
      focusIntent.target === 'inspection'
        ? inspectionHeading.current
        : focusIntent.target === 'trigger'
          ? trigger.current
          : document.getElementById(recordingStatementDomId(focusIntent.statement));
    if (!element) return;

    if (focusIntent.target === 'statement') {
      const passive = document.activeElement === document.body || document.activeElement === document.documentElement;
      if (!passive) {
        setFocusIntent(null);
        return;
      }
    }
    element.focus();
    setFocusIntent(null);
  }, [active, focusIntent, hasStatement, loading, scope]);

  const inspect = useCallback(
    (statement: string, button: HTMLButtonElement) => {
      if (!active() || !hasStatement(statement)) return;
      trigger.current = button;
      if (selectedStatement === statement) {
        setSelection(null);
        setFocusIntent({ scope, statement, target: 'trigger' });
      } else {
        setSelection({ scope, statement });
        setFocusIntent({ scope, statement, target: 'inspection' });
      }
    },
    [active, hasStatement, scope, selectedStatement],
  );

  const close = useCallback(() => {
    if (!selectedStatement || !active()) return;
    setSelection(null);
    setFocusIntent({ scope, statement: selectedStatement, target: 'trigger' });
  }, [active, scope, selectedStatement]);

  const restart = useCallback(() => {
    if (!active()) return;
    setSelection(null);
    setFocusIntent(null);
  }, [active]);

  return {
    selectedStatement,
    inspect,
    close,
    restart,
    inspectionHeading,
    trigger,
  };
}
