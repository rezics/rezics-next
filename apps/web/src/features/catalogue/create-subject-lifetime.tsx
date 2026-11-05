import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import type { TermDraft } from './create-subject';
import { SubjectTermsNavigationGuard } from './subject-terms-navigation';

/** Blank language rows contain no initial terms; a profile's preset Type is its clean baseline. */
export function hasInitialDraft(type: string, initialType: string, rows: TermDraft[]) {
  return type !== initialType || rows.some((row) => !!(row.label || row.description || row.aliases));
}

/** Profile producers own their state and callbacks. Observe their controls without preparing a command
 * (prepare may validate or publish feedback), and retain dirty state across independent Type drafts.
 */
export function CreateSubjectProfileDraft({
  type,
  children,
  onDirty,
}: {
  type: string;
  children: ReactNode;
  onDirty: (dirty: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drafts = useRef(new Map<string, { initial: string; current: string }>());
  const [, changed] = useState(0);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const observe = () => {
      const current = JSON.stringify(
        Array.from(node.querySelectorAll<HTMLInputElement>('input, select, textarea'), (control) => [
          control.tagName,
          control.type,
          control.value,
          'checked' in control && control.checked,
        ]),
      );
      const draft = drafts.current.get(type);
      drafts.current.set(type, { initial: draft?.initial ?? current, current });
      onDirty([...drafts.current.values()].some((value) => value.initial !== value.current));
    };
    observe();
    // Profile children can update their own staged rows without rerendering this form.
    const observer = new MutationObserver(observe);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  });
  return (
    <div ref={root} onChangeCapture={() => changed((value) => value + 1)}>
      {children}
    </div>
  );
}

export function CreateSubjectLifetime({
  locale,
  dirty,
  pending,
  confirmed,
  isActive,
}: {
  locale: string;
  dirty: boolean;
  pending: boolean;
  confirmed: boolean;
  isActive: () => boolean;
}) {
  return (
    <SubjectTermsNavigationGuard
      locale={locale}
      active={!confirmed}
      dirty={dirty}
      pending={pending}
      isActive={isActive}
      leaveLabel={m.thread_authoring_leave({}, { locale: locale as never })}
    />
  );
}
