import {
  isOverlayShortcut,
  overlayShortcutLabels,
  type OverlayPreferences,
  type OverlayShortcut,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { Switch } from '@rezics/ui/shadcn/switch';
import { useEffect, useId, useState } from 'react';
import type { DesktopApi, OverlayFailure, OverlayStatus } from '../shared/desktop';
import { Failure, Pending, useAction, useRemote } from './actions';

const failureMessage = {
  missing: 'The Overlay executable is missing. Check the Launcher installation.',
  'shortcut-mismatch': 'This Overlay build could not confirm the selected shortcut. Try Ctrl+Shift+Space.',
  webview2: 'Overlay could not start Microsoft Edge WebView2. Install or repair the runtime, then retry Overlay.',
  'webview2-startup': 'Microsoft Edge WebView2 is available. Overlay could not initialize it.',
  startup: 'Overlay could not start.',
  timeout: 'Overlay took too long to become ready.',
  exited: 'Overlay stopped unexpectedly.',
  session: 'Overlay could not attach to this game. Retry while the game is running.',
} satisfies Record<Exclude<OverlayFailure, 'hotkey'>, string>;
const shortcuts = Object.entries(overlayShortcutLabels).map(([value, label]) => ({ value, label }));

function OverlayShortcutField({
  shortcut,
  disabled,
  change,
}: {
  shortcut: OverlayShortcut;
  disabled: boolean;
  change: (shortcut: OverlayShortcut) => void;
}) {
  const id = useId();
  return (
    <Field className="max-w-72 gap-1" data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>Overlay shortcut</FieldLabel>
      <Select
        items={shortcuts}
        value={shortcut}
        disabled={disabled}
        onValueChange={(value) => {
          if (isOverlayShortcut(value) && value !== shortcut) change(value);
        }}
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {shortcuts.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function OverlayPreferencePanel({
  api,
}: {
  api: Pick<DesktopApi, 'overlayPreferences' | 'updateOverlayPreferences' | 'onOverlayPreferences'>;
}) {
  const id = useId();
  const preferences = useRemote(api.overlayPreferences);
  const { data, reload } = preferences;
  const action = useAction();
  useEffect(() => api.onOverlayPreferences(reload), [api, reload]);

  function save(patch: Partial<OverlayPreferences>) {
    void action.run(() => api.updateOverlayPreferences(patch));
  }

  return (
    <section className="section stack" aria-labelledby={id + '-title'}>
      <h2 id={id + '-title'}>Overlay settings</h2>
      {preferences.pending && !data && <Pending>Reading Overlay settings…</Pending>}
      <Failure error={preferences.error} retry={reload} />
      {data && (
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={action.pending || undefined}>
            <FieldLabel htmlFor={id}>Start Overlay with games</FieldLabel>
            <Switch
              id={id}
              checked={data.enabled}
              disabled={action.pending}
              onCheckedChange={(enabled) => save({ enabled })}
            />
          </Field>
          <OverlayShortcutField
            shortcut={data.shortcut}
            disabled={action.pending}
            change={(shortcut) => save({ shortcut })}
          />
        </FieldGroup>
      )}
      <Failure error={action.error} />
    </section>
  );
}

export function OverlayControls({
  api,
  sessionId,
}: {
  api: Pick<
    DesktopApi,
    'overlayStatus' | 'onOverlayStatus' | 'restartOverlay' | 'setOverlayShortcut' | 'openWebView2Download'
  >;
  sessionId: string;
}) {
  const [status, setStatus] = useState<OverlayStatus>();
  const action = useAction();
  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = api.onOverlayStatus((value) => {
      received = true;
      if (active) setStatus(value);
    });
    void api.overlayStatus().then(
      (value) => {
        if (active && !received) setStatus(value);
      },
      () => {},
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  if (!status || status.state === 'inactive' || status.sessionId !== sessionId) return null;
  if (status.state === 'disabled') {
    return (
      <p role="status" className="session-shortcut">
        Overlay is off. Turn it on in Extensions.
      </p>
    );
  }
  return (
    <>
      {status.state === 'starting' && (
        <span role="status" className="session-shortcut">
          Starting Overlay…
        </span>
      )}
      {status.state === 'failed' && (
        <p role="status" className="text-xs text-muted-foreground">
          {status.reason === 'hotkey'
            ? `Overlay could not register ${overlayShortcutLabels[status.shortcut]}. Choose another shortcut or retry.`
            : failureMessage[status.reason]}
        </p>
      )}
      <OverlayShortcutField
        shortcut={status.shortcut}
        disabled={action.pending}
        change={(shortcut) => void action.run(() => api.setOverlayShortcut(sessionId, shortcut))}
      />
      {status.state === 'failed' && status.reason === 'webview2' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={action.pending}
          onClick={() => void action.run(() => api.openWebView2Download(sessionId))}
        >
          Open WebView2 download
        </Button>
      )}
      {status.state !== 'starting' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={action.pending}
          onClick={() => void action.run(() => api.restartOverlay(sessionId))}
        >
          {status.state === 'failed' ? 'Retry Overlay' : 'Restart Overlay'}
        </Button>
      )}
      <Failure error={action.error} />
    </>
  );
}
