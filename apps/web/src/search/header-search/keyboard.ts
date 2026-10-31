/** Decide admission for this owner's real field before consuming the browser shortcut. */
export function canEnterHeaderSearch(event: KeyboardEvent, input: HTMLInputElement, entry: HTMLElement): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.key.toLowerCase() !== 'k' ||
    event.ctrlKey === event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !entry.isConnected ||
    !entry.getClientRects().length ||
    input.disabled ||
    entry.closest('[inert],[aria-hidden="true"]')
  )
    return false;

  // Inspect the event path as well as active focus, including shadow-hosted editors.
  const targets = [...event.composedPath(), input.ownerDocument.activeElement];
  for (const target of targets) {
    if (!(target instanceof HTMLElement) || target === input) continue;
    if (
      target.isContentEditable ||
      target.closest(
        'input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"],[role="combobox"],[role="searchbox"],[role="spinbutton"],[role="menu"],[role="listbox"]',
      )
    )
      return false;
  }

  // Never move focus out of another active modal/focus trap, even before it has transferred focus.
  const owner = input.closest('[data-header-search]');
  const traps = input.ownerDocument.querySelectorAll<HTMLElement>(
    'dialog[open],[aria-modal="true"],[data-focus-trap]:not([data-focus-trap="false"]),[data-focus-lock]:not([data-focus-lock="disabled"])',
  );
  return !Array.from(traps).some((trap) => trap !== owner && trap.getClientRects().length > 0);
}
