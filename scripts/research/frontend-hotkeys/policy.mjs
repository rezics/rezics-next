// Experiment policy only. The binding list is also the help/control metadata;
// it is not a second registry or a production command owner.
export const budgets = Object.freeze({ gzipDeltaBytes: 8192, brotliDeltaBytes: 6144,
  p95Ms: 8, p95DeltaMs: 1, stale: 0, duplicateOrBackground: 0, crossRequest: 0 });
export const candidates = ['native-as-is', 'native', 'ark', 'tanstack'];
export function bindings(count, search = 'Mod+K', disabled = false, sequence = false) {
  const rows = [
    { id: 'search', key: search, enabled: !disabled },
    { id: 'sidebar', key: 'Mod+B', enabled: true },
    { id: 'navigation-help', key: sequence ? ['G', 'H'] : 'Shift+/', enabled: !disabled },
  ];
  // Two fixed Tiptap behaviors (link and bold) complete the five-action workload.
  // Fillers exercise registration/dispatch scale without adding product actions.
  for (let i = 5; i < count; i++) rows.push({ id: `load-${i}`, key: `Control+Alt+Shift+${String.fromCharCode(65 + (i - 5) % 26)}`,
    enabled: i < 31 }); // Remaining rows use Meta below to avoid duplicate chords.
  for (let i = 31; i < count; i++) rows[i - 2] = { id: `load-${i}`,
    key: `Meta+Alt+Shift+${String.fromCharCode(65 + i - 31)}`, enabled: true };
  return rows;
}
export function blocked(event, id) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229
    || ['Process', 'Unidentified', 'Dead'].includes(event.key) || event.repeat
    || event.getModifierState?.('AltGraph')) return true;
  const path = event.composedPath();
  const elements = path.filter(node => node instanceof HTMLElement);
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true;
  if (elements.some(node => node.isContentEditable || node.closest('[role="menu"], [role="listbox"], [role="combobox"], [role="tree"], [role="grid"], [role="slider"]'))) return true;
  const editable = elements.some(node => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
  return editable && (id !== 'search' || !(event.ctrlKey || event.metaKey));
}
export function match(event, chord, apple = /Mac|iPhone|iPad/.test(navigator.platform)) {
  if (Array.isArray(chord)) return false;
  const parts = chord.toLowerCase().split('+');
  const key = parts.pop();
  const mod = parts.includes('mod');
  return event.key.toLowerCase() === (key === '/' && parts.includes('shift') ? '?' : key)
    && event.ctrlKey === (parts.includes('control') || mod && !apple)
    && event.metaKey === (parts.includes('meta') || mod && apple)
    && event.altKey === parts.includes('alt') && event.shiftKey === parts.includes('shift');
}
export function validateRemap(value) {
  if (!['Mod+K', 'Mod+J', '/'].includes(value)) return 'Choose Mod+K, Mod+J or /. Other, reserved and conflicting bindings are rejected.';
  return '';
}
export function ariaKey(chord, apple) {
  if (Array.isArray(chord)) return undefined; // ARIA has no sequence notation.
  return chord.replace('Mod', apple ? 'Meta' : 'Control');
}
