import {
  mergeEditorPreferences,
  editorPreferencesEqual,
  validateEditorPreferences,
  type EditorPreferences,
  type EditorPreferencePatch,
  type EditorPreferenceCommand,
} from '@rezics/editor/preferences';
import type { PreferenceChange, ReadingPreferences } from '../settings/preferences';
import type { ReadingIO } from '../settings/reading-preferences';
import { withManagedReadDeadline } from '../settings/managed-read-deadline';
import type { SettingsTimer, SettingsTimerHandle } from '../settings/ports/ambient';

export type EditorAccountPreferenceState = {
  known: ReadingPreferences | null;
  draft: EditorPreferences;
  state: 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
  /** An uncertain write keeps its exact version, patch and idempotency key until retry. */
  pending: Readonly<PreferenceChange> | null;
};
const same = editorPreferencesEqual;

/** A complete sparse replacement expressed as the native namespace's merge patch. */
export function editorReplacementPatch(
  before: EditorPreferences,
  after: EditorPreferences,
): EditorPreferencePatch | null {
  if (Object.keys(after).length === 0) return null;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const name = key as keyof EditorPreferences;
    if (same(before[name], after[name])) continue;
    if (key === 'keyboardBindings' && after.keyboardBindings !== undefined) {
      patch[key] = Object.fromEntries(
        [...new Set([...Object.keys(before.keyboardBindings ?? {}), ...Object.keys(after.keyboardBindings)])]
          .filter(
            (id) =>
              !same(
                before.keyboardBindings?.[id as EditorPreferenceCommand],
                after.keyboardBindings?.[id as EditorPreferenceCommand],
              ),
          )
          .map((id) => [id, after.keyboardBindings?.[id as EditorPreferenceCommand] ?? null]),
      );
    } else patch[key] = after[name] ?? null;
  }
  return patch as EditorPreferencePatch;
}

/** One mounted account observation owns its draft and all late preference callbacks. */
export class EditorAccountPreferences {
  private value: EditorAccountPreferenceState;
  private listeners = new Set<() => void>();
  private retired = false;
  private writing = false;
  private editing = 0;
  private timer: SettingsTimerHandle | null = null;
  constructor(
    private io: ReadingIO,
    private owner: {
      current: () => boolean;
      version: () => number;
      confirmed: (preferences: ReadingPreferences) => void;
      id: () => string;
      timer: SettingsTimer;
    },
    initial?: ReadingPreferences,
  ) {
    this.value = { known: initial ?? null, draft: initial?.editor ?? {}, state: 'idle', pending: null };
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private active = () => !this.retired && this.owner.current();
  private update(patch: Partial<EditorAccountPreferenceState>) {
    if (!this.active()) return;
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  dispose = () => {
    this.retired = true;
    this.timer?.cancel();
    this.timer = null;
    this.value = { known: null, draft: {}, state: 'idle', pending: null };
    this.listeners.clear();
  };
  adopt = (known: ReadingPreferences) => {
    if (
      !this.active() ||
      !validateEditorPreferences(known.editor ?? {}) ||
      this.value.pending ||
      known.version < (this.value.known?.version ?? 0)
    )
      return;
    const clean = same(this.value.draft, this.value.known?.editor ?? {});
    if (!clean && this.value.known && !same(known.editor ?? {}, this.value.known.editor ?? {})) {
      this.update({ known, state: 'conflict' });
      return;
    }
    this.owner.confirmed(known);
    this.update({ known, ...(clean ? { draft: known.editor ?? {} } : {}) });
  };
  edit = (next: EditorPreferences) => {
    if (!this.active() || !validateEditorPreferences(next)) return;
    this.editing++;
    this.update({
      draft: structuredClone(next),
      ...(this.value.pending || this.value.state === 'conflict' ? {} : { state: 'idle' }),
    });
    this.timer?.cancel();
    if (!this.value.pending && this.value.state !== 'conflict')
      this.timer = this.owner.timer.schedule(() => {
        this.timer = null;
        void this.save();
      }, 450);
  };
  private async read() {
    const page = await withManagedReadDeadline(() => this.io.read(), undefined, this.owner.timer);
    if (
      !this.active() ||
      !page.signedIn ||
      !('preferences' in page) ||
      page.preferences.advice?.allowedActions.read.allowed !== true ||
      page.preferences.version < this.owner.version() ||
      !validateEditorPreferences(page.preferences.editor ?? {})
    )
      return null;
    return page.preferences;
  }
  load = async () => {
    if (!this.active() || this.writing) return;
    const edit = this.editing;
    try {
      const known = await this.read();
      if (!known || !this.active()) {
        this.update({ state: 'error' });
        return;
      }
      this.owner.confirmed(known);
      this.update({
        known,
        ...(edit === 0 && this.editing === 0 && !this.value.known ? { draft: known.editor ?? {} } : {}),
      });
    } catch {
      this.update({ state: 'error' });
    }
  };
  /** Explicit conflict recovery discards only this editor preference draft, never other domains. */
  reload = async () => {
    if (!this.active() || this.writing) return;
    this.timer?.cancel();
    this.timer = null;
    try {
      const known = await this.read();
      if (!known || !this.active()) {
        this.update({ state: 'error' });
        return;
      }
      this.editing++;
      this.owner.confirmed(known);
      this.update({ known, draft: known.editor ?? {}, state: 'idle', pending: null });
    } catch {
      this.update({ state: 'error' });
    }
  };
  save = async () => {
    if (!this.active() || this.writing || this.value.state === 'conflict') return;
    this.timer?.cancel();
    this.timer = null;
    if (!this.value.known) await this.load();
    if (!this.active() || !this.value.known || this.value.known.advice?.allowedActions.update.allowed !== true) return;
    this.writing = true;
    const recovering = !!this.value.pending;
    try {
      let known = this.value.known;
      if (!this.value.pending && this.owner.version() > known.version) {
        const current = await this.read();
        if (!current) {
          this.update({ state: 'error' });
          return;
        }
        if (!same(current.editor ?? {}, known.editor ?? {})) {
          this.update({ known: current, state: 'conflict' });
          return;
        }
        known = current;
        this.owner.confirmed(current);
        this.update({ known });
      }
      if (!this.value.pending && same(known.editor ?? {}, this.value.draft)) {
        this.update({ state: 'saved' });
        return;
      }
      const input: Readonly<PreferenceChange> =
        this.value.pending ??
        Object.freeze({
          expectedVersion: known.version,
          editor: editorReplacementPatch(known.editor ?? {}, this.value.draft),
          idempotencyKey: this.owner.id(),
        });
      const sentDraft = mergeEditorPreferences(known.editor ?? {}, input.editor ?? null);
      this.update({ pending: input, state: 'saving' });
      const result = await withManagedReadDeadline(() => this.io.save(input), undefined, this.owner.timer);
      if (!this.active()) return;
      if (!result.ok) {
        this.update({
          state: result.reason === 'conflict' ? 'conflict' : 'error',
          ...(result.reason === 'conflict' || result.reason === 'invalid' || result.reason === 'forbidden'
            ? { pending: null }
            : {}),
        });
        return;
      }
      if (
        !validateEditorPreferences(result.preferences.editor ?? {}) ||
        !same(result.preferences.editor ?? {}, sentDraft)
      ) {
        this.update({ state: 'error' });
        return;
      }
      let confirmed = result.preferences;
      if (recovering) {
        const current = await this.read();
        if (!current || current.version < confirmed.version) {
          this.update({ state: 'error' });
          return;
        }
        confirmed = current;
      }
      this.owner.confirmed(confirmed);
      this.update({
        known: confirmed,
        pending: null,
        state: 'saved',
        ...(same(this.value.draft, sentDraft) ? { draft: confirmed.editor ?? {} } : {}),
      });
    } catch {
      this.update({ state: 'error' });
    } finally {
      this.writing = false;
      if (
        this.active() &&
        !this.value.pending &&
        this.value.state === 'saved' &&
        !same(this.value.known?.editor ?? {}, this.value.draft)
      )
        await this.save();
    }
  };
}
