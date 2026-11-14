import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { resolveEditorPreferences, mergeEditorPreferences, type EditorPreferences } from '@rezics/editor/preferences';
import type { EditorPreferencesScope, EditorPreferencesStatus } from '@rezics/editor';
import { useSession } from '../session';
import { cachedBrowserSession } from '../session/browser-state';
import { readSettingsPage, savePreferences } from '../settings/actions';
import type { ReadingPreferences } from '../settings/preferences';
import type { ReadingIO } from '../settings/reading-preferences';
import { createBrowserSettingsAmbient } from '../settings/adapters/ambient';
import { EditorAccountPreferences, editorReplacementPatch } from './preference-state';
import { composeEditorPreferenceOverrides, emptyEditorPreferences, LocalEditorPreferences } from './local-preferences';
import { accountPreferenceVersion, confirmAccountPreferenceVersion } from './preference-version';

type AccountEntry = { controller: EditorAccountPreferences; users: number; loaded: boolean };
const accounts = new WeakMap<QueryClient, Map<string, AccountEntry>>();
const local = new Map<string, LocalEditorPreferences>();
const emptyAccount = { known: null, draft: emptyEditorPreferences, state: 'idle' as const, pending: null };
const noSubscribe = () => () => {};
const accountSnapshot = () => emptyAccount;

function localPreferences(scope: 'device' | 'session', subject: string) {
  const key = `rezics.editor.${scope}.v1:${subject}`;
  let store = local.get(key);
  if (!store) {
    store = new LocalEditorPreferences(key, () =>
      typeof window === 'undefined' ? null : scope === 'device' ? window.localStorage : window.sessionStorage,
    );
    local.set(key, store);
  }
  return store;
}

function accountPreferences(
  client: QueryClient,
  subject: string,
  token: string,
  options: {
    initial?: ReadingPreferences | undefined;
    io?: ReadingIO | undefined;
  },
) {
  let entries = accounts.get(client);
  if (!entries) {
    entries = new Map();
    accounts.set(client, entries);
  }
  const key = JSON.stringify([subject, token]);
  let entry = entries.get(key);
  if (!entry) {
    const current = () => {
      const session = cachedBrowserSession(client);
      return session.state === 'signed-in' && session.subject === subject && session.csrfToken === token;
    };
    const io: ReadingIO = options.io ?? {
      read: async () => {
        if (!current()) throw new Error('Editor preference viewer unavailable');
        const page = await readSettingsPage();
        if (!current() || (page.signedIn && page.accountId !== subject))
          throw new Error('Editor preference viewer changed');
        return page;
      },
      save: async (data) => {
        if (!current()) return { ok: false, reason: 'forbidden' };
        const result = await savePreferences({ data, headers: { 'X-CSRF-Token': token } });
        if (!current()) throw new Error('Editor preference viewer changed');
        return result;
      },
    };
    const ambient = createBrowserSettingsAmbient();
    entry = {
      users: 0,
      loaded: !!options.initial,
      controller: new EditorAccountPreferences(
        io,
        {
          current,
          version: () => accountPreferenceVersion(client, subject),
          confirmed: (preferences) => confirmAccountPreferenceVersion(client, subject, preferences.version),
          id: ambient.id,
          timer: ambient.timer,
        },
        options.initial,
      ),
    };
    entries.set(key, entry);
  }
  const selected = entry;
  return {
    ...entry,
    mount: () => {
      selected.users++;
      if (!selected.loaded) {
        selected.loaded = true;
        void selected.controller.load();
      }
      return () => {
        selected.users--;
        queueMicrotask(() => {
          if (selected.users === 0) {
            selected.controller.dispose();
            entries!.delete(key);
          }
        });
      };
    },
  };
}

export function useEditorPreferences(
  options: {
    initial?: ReadingPreferences | undefined;
    io?: ReadingIO | undefined;
    version?: number | undefined;
    onVersionChange?: ((version: number) => void) | undefined;
  } = {},
) {
  const session = useSession();
  const client = useQueryClient();
  const subject = session.state === 'signed-in' && session.subject ? session.subject : 'anonymous';
  const token = session.state === 'signed-in' ? session.csrfToken : null;
  const ready = subject !== 'anonymous' && !!token;
  const identity = JSON.stringify([subject, token]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [selection, setSelection] = useState<{ identity: string; scope: EditorPreferencesScope }>(() => ({
    identity,
    scope: ready ? 'account' : 'device',
  }));
  const scope =
    selection.identity === identity && (ready || selection.scope !== 'account')
      ? selection.scope
      : ready
        ? 'account'
        : 'device';
  const entry = useMemo(
    () => (ready ? accountPreferences(client, subject, token!, options) : null),
    [client, subject, token, ready],
  );
  const account = useSyncExternalStore(
    entry?.controller.subscribe ?? noSubscribe,
    entry?.controller.snapshot ?? accountSnapshot,
    accountSnapshot,
  );
  useLayoutEffect(() => entry?.mount(), [entry]);
  useLayoutEffect(() => {
    if (options.initial) entry?.controller.adopt(options.initial);
  }, [entry, options.initial]);
  useLayoutEffect(() => {
    if (ready && options.version !== undefined) confirmAccountPreferenceVersion(client, subject, options.version);
  }, [client, subject, ready, options.version]);
  const confirmedVersion = account.known?.version;
  useEffect(() => {
    if (confirmedVersion !== undefined) options.onVersionChange?.(confirmedVersion);
  }, [confirmedVersion, options.onVersionChange]);
  const device = useMemo(() => localPreferences('device', subject), [subject]);
  const sessionStore = useMemo(() => localPreferences('session', subject), [subject]);
  const deviceValue = useSyncExternalStore(device.subscribe, device.snapshot, device.serverSnapshot);
  const sessionValue = useSyncExternalStore(sessionStore.subscribe, sessionStore.snapshot, sessionStore.serverSnapshot);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (!event.key || event.key === device.key) device.refresh();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [device]);
  const [localStatus, setLocalStatus] = useState<EditorPreferencesStatus>({ state: 'idle' });
  const accountValue = ready ? account.draft : emptyEditorPreferences;
  const effective = resolveEditorPreferences(accountValue, deviceValue, sessionValue);
  const panelValue =
    scope === 'account'
      ? resolveEditorPreferences(accountValue)
      : scope === 'device'
        ? resolveEditorPreferences(accountValue, deviceValue)
        : effective;
  const current = useRef({ scope, effective: panelValue, accountValue, deviceValue, sessionValue });
  current.current = { scope, effective: panelValue, accountValue, deviceValue, sessionValue };
  const change = useCallback(
    (next: EditorPreferences) => {
      if (identityRef.current !== identity) return;
      const state = current.current;
      const own =
        state.scope === 'account'
          ? state.accountValue
          : state.scope === 'device'
            ? state.deviceValue
            : state.sessionValue;
      const delta = Object.keys(next).length === 0 ? null : editorReplacementPatch(state.effective, next);
      const changed = mergeEditorPreferences(own, delta);
      if (!changed) return;
      if (state.scope === 'account') entry?.controller.edit(changed);
      else
        setLocalStatus({
          state: (state.scope === 'device' ? device : sessionStore).write(changed) ? 'saved' : 'error',
        });
    },
    [identity, entry, device, sessionStore],
  );
  const onScopeChange = useCallback(
    (next: EditorPreferencesScope) => {
      if (identityRef.current !== identity || (!ready && next === 'account')) return;
      setSelection({ identity, scope: next });
      setLocalStatus({ state: 'idle' });
    },
    [identity, ready],
  );
  return {
    preferences: composeEditorPreferenceOverrides(accountValue, deviceValue, sessionValue),
    preferencesPanelValue: panelValue,
    onPreferencesChange: change,
    preferencesScope: scope,
    preferencesScopes: (ready
      ? ['account', 'device', 'session']
      : ['device', 'session']) as readonly EditorPreferencesScope[],
    onPreferencesScopeChange: onScopeChange,
    preferencesStatus: scope === 'account' ? { state: account.state } : localStatus,
    preferencesDisabled:
      scope === 'account' &&
      (!account.known || account.known.advice?.allowedActions.update.allowed !== true || account.state === 'conflict'),
    onPreferencesRetry: () => {
      if (identityRef.current === identity)
        scope === 'account' ? void entry?.controller.save() : change(current.current.effective);
    },
    onPreferencesReload: () => {
      if (identityRef.current === identity) void entry?.controller.reload();
    },
  };
}
