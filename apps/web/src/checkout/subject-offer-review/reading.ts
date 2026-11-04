import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SubjectOffer, SubjectOffersPage } from '../subject-offers';
import { sameSubjectOffer } from './model';

type Operand = { offer: SubjectOffer; trigger: HTMLButtonElement };
type Mode = { kind: 'inspect'; operand: Operand } | { kind: 'compare'; trigger: HTMLButtonElement } | null;
type Scope = { page: SubjectOffersPage; version: number; locale: string; address: string };
type Selection = { scope: Scope; operands: readonly Operand[]; mode: Mode };

function sameScope(a: Scope, b: Scope) {
  return a.page === b.page && a.version === b.version && a.locale === b.locale && a.address === b.address;
}

/** Only this mounted received page owns these two operands. There is no persistence or command port. */
export function useSubjectOfferReading({
  page,
  version,
  locale,
  current: admitted,
}: {
  page: SubjectOffersPage;
  version: number;
  locale: string;
  current?: (() => boolean) | undefined;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const address = typeof window === 'undefined' ? '' : window.location.href;
  const scope = { page, version, locale, address };
  const [selection, setSelection] = useState<Selection>(() => ({ scope, operands: [], mode: null }));
  const live = useRef({ scope, admitted, visible: true, selection });
  let selected = selection;
  // Retire during render, before current labels or links can be paired with an old operand.
  if (!sameScope(selection.scope, scope)) {
    selected = { scope, operands: [], mode: null };
    setSelection(selected);
  }
  live.current.scope = scope;
  live.current.admitted = admitted;
  live.current.selection = selected;

  function current() {
    const value = live.current;
    return (
      value.visible &&
      sameScope(value.scope, scope) &&
      (typeof window === 'undefined' || window.location.href === scope.address) &&
      (!value.admitted || value.admitted())
    );
  }

  function commit(next: Selection) {
    live.current.selection = next;
    setSelection(next);
  }

  function connected(trigger: HTMLButtonElement | undefined) {
    if (trigger?.isConnected) trigger.focus();
  }

  function received(offer: SubjectOffer) {
    // Membership must be the actual object on the current received page, not a recreated title/revision match.
    return current() && live.current.scope.page.offers.some((row) => row === offer);
  }

  function close() {
    if (!current()) return;
    const state = live.current.selection;
    const trigger = state.mode?.kind === 'inspect' ? state.mode.operand.trigger : state.mode?.trigger;
    commit({ ...state, mode: null });
    connected(trigger);
  }

  useLayoutEffect(() => {
    live.current.visible = true;
    const retire = () => {
      const value = live.current;
      value.visible = false;
      const next = { scope: value.scope, operands: [], mode: null };
      value.selection = next;
      setSelection(next);
    };
    const resume = () => {
      live.current.visible = true;
    };
    const addressChanged = () => {
      retire();
      resume();
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', resume);
    window.addEventListener('popstate', addressChanged);
    window.addEventListener('hashchange', addressChanged);
    return () => {
      live.current.visible = false;
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('popstate', addressChanged);
      window.removeEventListener('hashchange', addressChanged);
    };
  }, []);

  useLayoutEffect(() => {
    if (selected.mode && current()) heading.current?.focus();
  }, [selected.mode]);

  return {
    id,
    heading,
    mode: current() ? selected.mode : null,
    operands: current() ? selected.operands : [],
    current,
    close,
    inspect(offer: SubjectOffer, trigger: HTMLButtonElement) {
      if (!received(offer)) return;
      commit({ ...live.current.selection, mode: { kind: 'inspect', operand: { offer, trigger } } });
    },
    inspected(offer: SubjectOffer) {
      return selected.mode?.kind === 'inspect' && sameSubjectOffer(selected.mode.operand.offer, offer);
    },
    chosen(offer: SubjectOffer) {
      return selected.operands.some((operand) => sameSubjectOffer(operand.offer, offer));
    },
    toggle(offer: SubjectOffer, trigger: HTMLButtonElement) {
      if (!received(offer)) return;
      const state = live.current.selection;
      const exists = state.operands.some((operand) => sameSubjectOffer(operand.offer, offer));
      if (!exists && state.operands.length === 2) return;
      commit({
        ...state,
        mode: state.mode?.kind === 'compare' ? null : state.mode,
        operands: exists
          ? state.operands.filter((operand) => !sameSubjectOffer(operand.offer, offer))
          : [...state.operands, { offer, trigger }],
      });
    },
    compare(trigger: HTMLButtonElement) {
      const state = live.current.selection;
      if (!current() || state.operands.length !== 2 || !state.operands.every(({ offer }) => received(offer))) return;
      commit({ ...state, mode: { kind: 'compare', trigger } });
    },
    returnToRow(offer: SubjectOffer) {
      if (!received(offer)) return;
      const state = live.current.selection;
      const operand = state.operands.find((item) => sameSubjectOffer(item.offer, offer));
      if (!operand) return;
      commit({ ...state, mode: null });
      connected(operand.trigger);
    },
    remove(offer: SubjectOffer) {
      if (!received(offer)) return;
      const state = live.current.selection;
      const operand = state.operands.find((item) => sameSubjectOffer(item.offer, offer));
      commit({ ...state, mode: null, operands: state.operands.filter((item) => item !== operand) });
      connected(operand?.trigger);
    },
    clear() {
      if (!current()) return;
      const state = live.current.selection;
      const trigger =
        state.mode?.kind === 'inspect'
          ? state.mode.operand.trigger
          : (state.mode?.trigger ?? state.operands[0]?.trigger);
      commit({ ...state, mode: null, operands: [] });
      connected(trigger);
    },
  };
}
export type SubjectOfferReading = ReturnType<typeof useSubjectOfferReading>;
