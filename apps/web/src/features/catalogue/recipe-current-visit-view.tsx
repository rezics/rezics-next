import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RecipeCurrentReturn, RecipeCurrentReturnState } from './recipe-current-visit';

export function RecipeVisitNotice({
  locale,
  invalid,
  sourceHref,
  globalHref,
}: {
  locale: string;
  invalid?: boolean;
  sourceHref?: string | undefined;
  globalHref?: string | undefined;
}) {
  const o = { locale: locale as never };
  return (
    <section className="space-y-4" aria-label={m.recipe_edit({}, o)}>
      {invalid && <PageHeading>{m.recipe_edit({}, o)}</PageHeading>}
      <p role="alert">{invalid ? m.recipe_visit_invalid({}, o) : m.recipe_visit_unsupported({}, o)}</p>
      {sourceHref && (
        <a className="inline-flex min-h-11 items-center underline" href={sourceHref}>
          {m.recipe_visit_return({}, o)}
        </a>
      )}
      {globalHref && (
        <a className="inline-flex min-h-11 items-center underline" href={globalHref}>
          {m.recipe_visit_global({}, o)}
        </a>
      )}
    </section>
  );
}

export function RecipeCurrentVisitReturn({
  locale,
  address,
  intent,
  state,
  invalid = false,
  restartHref,
}: {
  locale: string;
  address: string;
  intent?: RecipeCurrentReturn;
  state?: RecipeCurrentReturnState;
  invalid?: boolean;
  restartHref?: string;
}) {
  const o = { locale: locale as never };
  const admission = useRef<{ key: string; address: string; cancelled: boolean } | undefined>(undefined);
  const programmaticTarget = useRef<HTMLElement | undefined>(undefined);
  const [focusMissing, setFocusMissing] = useState(false);
  useLayoutEffect(() => {
    if (!intent?.occurrence) return;
    const document = globalThis.document;
    const key = `${intent.recipe}:${intent.visit}`;
    if (admission.current?.key !== key) admission.current = { key, address, cancelled: false };
    else if (admission.current.address !== address) admission.current.cancelled = true;
    admission.current.address = address;
    const cancel = () => {
      if (programmaticTarget.current && document.activeElement === programmaticTarget.current) return;
      if (admission.current?.key === key) admission.current.cancelled = true;
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.defaultView?.removeEventListener('blur', cancel);
    };
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    document.defaultView?.addEventListener('blur', cancel);
    return cancel;
  }, [address, intent?.focus, intent?.occurrence?.statement, intent?.recipe, intent?.visit]);
  useLayoutEffect(() => {
    setFocusMissing(false);
    if (state !== 'ready' || !intent?.occurrence) return;
    const key = `${intent.recipe}:${intent.visit}`;
    if (admission.current?.key !== key || admission.current.cancelled) return;
    const target = globalThis.document.querySelector<HTMLElement>(
      `[data-recipe-current-statement="${intent.occurrence.statement}"]`,
    );
    if (!target) {
      setFocusMissing(true);
      return;
    }
    if (intent.focus === 'keyboard') {
      target.tabIndex = -1;
      programmaticTarget.current = target;
      target.focus();
      programmaticTarget.current = undefined;
    } else target.scrollIntoView({ block: 'center' });
  }, [address, intent, state]);

  const message = invalid
    ? m.recipe_visit_invalid({}, o)
    : focusMissing || state === 'removed'
      ? m.recipe_return_occurrence_missing({}, o)
      : state === 'changed'
        ? m.recipe_return_context_changed({}, o)
        : state === 'unsupported'
          ? m.recipe_return_unsupported({}, o)
          : undefined;
  if (!message) return null;
  return (
    <div className="space-y-2" data-recipe-return-state={invalid ? 'invalid' : state}>
      <p role="status">{message}</p>
      {restartHref && (
        <a className="inline-flex min-h-11 items-center underline" href={restartHref}>
          {m.recipe_return_restart({}, o)}
        </a>
      )}
    </div>
  );
}
