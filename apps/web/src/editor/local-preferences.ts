import { editorPreferencesEqual, validateEditorPreferences, type EditorPreferences } from '@rezics/editor/preferences';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const emptyEditorPreferences: EditorPreferences = Object.freeze({});

/** Preserve omitted fields so editor presets can still supply their documented control defaults. */
export function composeEditorPreferenceOverrides(...layers: EditorPreferences[]): EditorPreferences {
  let result: EditorPreferences = {};
  for (const layer of layers) {
    const bindings =
      layer.keyboardBindings === undefined
        ? result.keyboardBindings
        : { ...result.keyboardBindings, ...layer.keyboardBindings };
    result = { ...result, ...layer, ...(bindings === undefined ? {} : { keyboardBindings: bindings }) };
  }
  return result;
}

/** Versioned browser overrides contain no document, token or synchronized account snapshot. */
export class LocalEditorPreferences {
  private value: EditorPreferences = emptyEditorPreferences;
  private listeners = new Set<() => void>();
  constructor(
    readonly key: string,
    private storage: () => PreferenceStorage | null,
  ) {
    this.refresh();
  }
  snapshot = () => this.value;
  serverSnapshot = () => emptyEditorPreferences;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  refresh = () => {
    let value: EditorPreferences = emptyEditorPreferences;
    try {
      const raw = this.storage()?.getItem(this.key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'version' in parsed &&
          parsed.version === 1 &&
          'preferences' in parsed &&
          validateEditorPreferences(parsed.preferences)
        )
          value = parsed.preferences;
      }
    } catch {
      /* Storage restrictions leave device-local editing available in memory. */
    }
    if (!editorPreferencesEqual(value, this.value)) {
      this.value = value;
      this.listeners.forEach((listener) => listener());
    }
  };
  write = (next: EditorPreferences): boolean => {
    if (!validateEditorPreferences(next)) return false;
    this.value = structuredClone(next);
    let persisted = false;
    try {
      const storage = this.storage();
      if (storage) {
        if (Object.keys(next).length) storage.setItem(this.key, JSON.stringify({ version: 1, preferences: next }));
        else storage.removeItem(this.key);
        persisted = true;
      }
    } catch {
      /* Retain the live preview, but report that persistence failed. */
    }
    this.listeners.forEach((listener) => listener());
    return persisted;
  };
}
