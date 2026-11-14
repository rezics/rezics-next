/** Portable private editor preferences. These values never become authored document attributes. */
export const editorCommandIds = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'table',
  'image',
  'bold',
  'italic',
  'underline',
  'strike',
  'spoiler',
  'code',
  'link',
  'clearFormatting',
  'undo',
  'redo',
  'ruby',
  'language',
  'footnote',
  'indentList',
  'outdentList',
  'toggleTask',
  'moveBlockUp',
  'moveBlockDown',
  'duplicateBlock',
  'deleteBlock',
  'addColumnBefore',
  'addColumnAfter',
  'deleteColumn',
  'addRowBefore',
  'addRowAfter',
  'deleteRow',
  'mergeCells',
  'splitCell',
  'toggleHeaderRow',
  'toggleHeaderColumn',
  'toggleHeaderCell',
  'deleteTable',
  'selectRow',
  'selectColumn',
  'selectTable',
  'alignCellLeft',
  'alignCellCenter',
  'alignCellRight',
  'alignCellDefault',
  'moveRowUp',
  'moveRowDown',
  'moveColumnLeft',
  'moveColumnRight',
  'find',
  'findNext',
  'findPrevious',
  'replace',
  'commandPalette',
] as const;
export type EditorPreferenceCommand = (typeof editorCommandIds)[number];
export type EditorTypeface = 'sans' | 'serif' | 'mono' | 'custom';
export type EditorToolbarMode = 'auto' | 'fixed' | 'floating' | 'hidden';
export type EditorPreferences = {
  typeface?: EditorTypeface;
  customFont?: string;
  textSize?: number;
  lineSpacing?: number;
  writingWidth?: number;
  toolbar?: EditorToolbarMode;
  outline?: boolean;
  markdownShortcuts?: boolean;
  spellcheck?: boolean;
  pasteMode?: 'rich' | 'plain';
  autoLink?: boolean;
  pinnedCommands?: EditorPreferenceCommand[];
  hiddenCommands?: EditorPreferenceCommand[];
  commandOrder?: EditorPreferenceCommand[];
  /** An empty chord disables this command's default shortcut. */
  keyboardBindings?: Partial<Record<EditorPreferenceCommand, string>>;
};
export type ResolvedEditorPreferences = Required<EditorPreferences>;
/** JSON Merge Patch: null removes an override; arrays replace, keyboard entries merge. */
export type EditorPreferencePatch = {
  [K in Exclude<keyof EditorPreferences, 'keyboardBindings'>]?: EditorPreferences[K] | null;
} & {
  keyboardBindings?: Partial<Record<EditorPreferenceCommand, string | null>> | null;
};

export const defaultEditorKeyboardBindings: Readonly<Partial<Record<EditorPreferenceCommand, string>>> = Object.freeze({
  bold: 'Mod-b',
  italic: 'Mod-i',
  underline: 'Mod-u',
  strike: 'Mod-Shift-s',
  code: 'Mod-e',
  link: 'Mod-k',
  undo: 'Mod-z',
  redo: 'Mod-Shift-z',
  paragraph: 'Mod-Alt-0',
  heading1: 'Mod-Alt-1',
  heading2: 'Mod-Alt-2',
  heading3: 'Mod-Alt-3',
  bulletList: 'Mod-Shift-8',
  orderedList: 'Mod-Shift-7',
  blockquote: 'Mod-Shift-b',
  codeBlock: 'Mod-Alt-c',
  find: 'Mod-f',
  commandPalette: 'Mod-Shift-k',
});

export const editorPreferenceDefaults: Readonly<ResolvedEditorPreferences> = Object.freeze({
  typeface: 'sans',
  customFont: '',
  textSize: 16,
  lineSpacing: 1.7,
  writingWidth: 72,
  toolbar: 'auto',
  outline: false,
  markdownShortcuts: true,
  spellcheck: true,
  pasteMode: 'rich',
  autoLink: true,
  pinnedCommands: Object.freeze([]) as unknown as EditorPreferenceCommand[],
  hiddenCommands: Object.freeze([]) as unknown as EditorPreferenceCommand[],
  commandOrder: Object.freeze([]) as unknown as EditorPreferenceCommand[],
  keyboardBindings: defaultEditorKeyboardBindings,
});

const fields = new Set(Object.keys(editorPreferenceDefaults));
const commands = new Set<string>(editorCommandIds);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const command = (value: unknown): value is EditorPreferenceCommand => typeof value === 'string' && commands.has(value);
const bounded = (value: unknown, minimum: number, maximum: number, integer = false) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum &&
  (!integer || Number.isInteger(value));
const commandArray = (value: unknown) =>
  Array.isArray(value) && value.length <= 64 && value.every(command) && new Set(value).size === value.length;

/** JSON object order is immaterial; command array order and explicit sparse overrides are meaningful. */
export function editorPreferencesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => editorPreferencesEqual(value, right[index]))
    );
  }
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && editorPreferencesEqual(left[key], right[key]),
    )
  );
}

/** A canonical, platform-independent chord. Plain text and native editing keys cannot be rebound. */
export function normalizeEditorShortcut(value: string): string | undefined {
  if (!value || value.length > 80) return undefined;
  const parts = value.trim().split('-');
  const key = parts.pop();
  if (
    !key ||
    !/^(?:[a-z0-9/.,;=\[\]\\]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space)$/i.test(key)
  )
    return undefined;
  const modifiers = parts.map(
    (part) => ({ mod: 'Mod', ctrl: 'Ctrl', meta: 'Meta', alt: 'Alt', shift: 'Shift' })[part.toLowerCase()],
  );
  if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length) return undefined;
  if (!modifiers.some((part) => ['Mod', 'Ctrl', 'Meta', 'Alt'].includes(part!)) && !/^F\d+$/i.test(key))
    return undefined;
  if (modifiers.includes('Mod') && (modifiers.includes('Ctrl') || modifiers.includes('Meta'))) return undefined;
  const normalizedKey =
    key.length === 1
      ? key.toLowerCase()
      : /^f\d+$/i.test(key)
        ? key.toUpperCase()
        : ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'].find(
            (name) => name.toLowerCase() === key.toLowerCase(),
          );
  return normalizedKey
    ? [...['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].filter((part) => modifiers.includes(part)), normalizedKey].join('-')
    : undefined;
}

function shortcutIdentity(chord: string): string {
  // Mod means Ctrl or Meta, so a portable binding must not collide on either platform.
  return chord.replace(/^(?:Mod|Ctrl|Meta)-/, 'Primary-');
}

function reservedShortcut(chord: string): boolean {
  const identity = shortcutIdentity(chord);
  return (
    /^(?:Primary-(?:Shift-)?(?:a|c|x|v|q|w|t|n|r|l|p|Space)|Primary-s|Alt-(?:Shift-)?Space|(?:Ctrl|Meta|Mod)-Alt-Space|F(?:1|5|11|12))$/.test(
      identity,
    ) ||
    // Ctrl+Alt is AltGr on common layouts and must continue entering native text.
    /^(?:Ctrl|Mod)-Alt-(?![0-9]|c$)/.test(chord)
  );
}

export type EditorShortcutIssue = { reason: 'invalid' | 'reserved' | 'conflict'; command?: EditorPreferenceCommand };
export function editorShortcutIssue(
  id: EditorPreferenceCommand,
  chord: string,
  overrides: EditorPreferences['keyboardBindings'] = {},
): EditorShortcutIssue | undefined {
  if (chord === '') return undefined;
  const normalized = normalizeEditorShortcut(chord);
  if (!normalized) return { reason: 'invalid' };
  if (reservedShortcut(normalized)) return { reason: 'reserved' };
  const effective = { ...defaultEditorKeyboardBindings, ...overrides, [id]: normalized };
  for (const [other, binding] of Object.entries(effective)) {
    if (
      other !== id &&
      binding &&
      shortcutIdentity(normalizeEditorShortcut(binding) ?? binding) === shortcutIdentity(normalized)
    ) {
      return { reason: 'conflict', command: other as EditorPreferenceCommand };
    }
  }
  return undefined;
}

function validField(key: string, value: unknown, patch: boolean): boolean {
  if (patch && value === null) return true;
  switch (key) {
    case 'typeface':
      return ['sans', 'serif', 'mono', 'custom'].includes(value as string);
    case 'customFont':
      return typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f;{}<>]/.test(value);
    case 'textSize':
      return bounded(value, 12, 32, true);
    case 'lineSpacing':
      return bounded(value, 1, 2.5);
    case 'writingWidth':
      return bounded(value, 40, 120, true);
    case 'toolbar':
      return ['auto', 'fixed', 'floating', 'hidden'].includes(value as string);
    case 'pasteMode':
      return value === 'rich' || value === 'plain';
    case 'outline':
    case 'markdownShortcuts':
    case 'spellcheck':
    case 'autoLink':
      return typeof value === 'boolean';
    case 'pinnedCommands':
    case 'hiddenCommands':
    case 'commandOrder':
      return commandArray(value);
    case 'keyboardBindings':
      return (
        record(value) &&
        Object.keys(value).length <= 64 &&
        Object.entries(value).every(
          ([id, chord]) =>
            command(id) &&
            ((patch && chord === null) ||
              (typeof chord === 'string' && (chord === '' || normalizeEditorShortcut(chord) === chord))),
        )
      );
    default:
      return false;
  }
}

export function validateEditorPreferences(value: unknown): value is EditorPreferences {
  if (
    !record(value) ||
    !Object.entries(value).every(([key, entry]) => fields.has(key) && validField(key, entry, false))
  )
    return false;
  const bindings = value.keyboardBindings as EditorPreferences['keyboardBindings'];
  return (
    !bindings ||
    Object.entries(bindings).every(
      ([id, chord]) => !editorShortcutIssue(id as EditorPreferenceCommand, chord!, bindings),
    )
  );
}

export function validateEditorPreferencePatch(value: unknown): value is EditorPreferencePatch | null {
  return (
    value === null ||
    (record(value) && Object.entries(value).every(([key, entry]) => fields.has(key) && validField(key, entry, true)))
  );
}

export function mergeEditorPreferences(
  stored: EditorPreferences,
  patch: EditorPreferencePatch | null,
): EditorPreferences | null {
  if (!validateEditorPreferencePatch(patch)) return null;
  if (patch === null) return {};
  const next: Record<string, unknown> = structuredClone(stored);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (key === 'keyboardBindings') {
      const bindings = { ...(record(next[key]) ? next[key] : {}) };
      for (const [id, chord] of Object.entries(value as Record<string, string | null>)) {
        if (chord === null) delete bindings[id];
        else bindings[id] = chord;
      }
      next[key] = bindings;
    } else next[key] = structuredClone(value);
  }
  return validateEditorPreferences(next) ? next : null;
}

/** Later layers win; a host can supply account, then device, then session overrides. */
export function resolveEditorPreferences(...layers: EditorPreferences[]): ResolvedEditorPreferences {
  const resolved: ResolvedEditorPreferences = {
    ...editorPreferenceDefaults,
    pinnedCommands: [],
    hiddenCommands: [],
    commandOrder: [],
    keyboardBindings: { ...defaultEditorKeyboardBindings },
  };
  for (const layer of layers) {
    Object.assign(resolved, layer, { keyboardBindings: { ...resolved.keyboardBindings, ...layer.keyboardBindings } });
  }
  return {
    ...resolved,
    pinnedCommands: [...resolved.pinnedCommands],
    hiddenCommands: [...resolved.hiddenCommands],
    commandOrder: [...resolved.commandOrder],
  };
}
