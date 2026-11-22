import type { Instance } from '@rezics/launcher-contract';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useEffect, useId } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import { ConfirmAction } from '../renderer/confirm-action';
import type { DesktopApi } from '../shared/desktop';

export type MinecraftAccountApi = Pick<
  DesktopApi,
  | 'minecraftAccounts'
  | 'selectMinecraftAccount'
  | 'forgetMinecraftAccount'
  | 'beginMinecraftSignIn'
  | 'readMinecraftSignIn'
  | 'cancelMinecraftSignIn'
  | 'onMinecraftSignInChanged'
  | 'openMicrosoftSignIn'
>;

export function MinecraftAccount({ api }: { api: MinecraftAccountApi }) {
  const accounts = useRemote(api.minecraftAccounts);
  const signIn = useRemote(api.readMinecraftSignIn);
  const reloadAccounts = accounts.reload;
  const reloadSignIn = signIn.reload;
  useEffect(
    () =>
      api.onMinecraftSignInChanged(() => {
        reloadSignIn();
        reloadAccounts();
      }),
    [api, reloadAccounts, reloadSignIn],
  );
  const action = useAction();
  const cancel = useAction();
  const browser = useAction();
  const state = signIn.data?.state;
  const device = signIn.data?.state === 'waiting' && signIn.data.device;
  const signingIn = state === 'requesting' || state === 'waiting' || state === 'saving';
  const disabled = action.pending || cancel.pending || !signIn.data || signingIn;

  function begin(accountId?: string) {
    void action.run(() => api.beginMinecraftSignIn(accountId));
  }

  return (
    <section className="section stack" aria-labelledby="minecraft-account">
      <div className="section-heading">
        <h2 id="minecraft-account" tabIndex={-1}>
          Minecraft accounts
        </h2>
        {accounts.data && !signingIn && (
          <Button
            size="sm"
            variant={accounts.data.profiles.length ? 'outline' : 'default'}
            disabled={disabled}
            onClick={() => begin()}
          >
            {accounts.data.profiles.length ? 'Add Microsoft account' : 'Sign in with Microsoft'}
          </Button>
        )}
      </div>
      {accounts.pending && !accounts.data && <Pending>Checking accounts…</Pending>}
      {accounts.data && (
        <ul className="rows">
          {accounts.data.profiles.map((profile) => {
            const selected = profile.id === accounts.data?.activeId;
            return (
              <li className="row-item" key={profile.id}>
                <div className="row-content">
                  <div className="row-text">
                    <div className="actions">
                      <strong>{profile.name}</strong>
                      {selected && <Badge variant="secondary">Default</Badge>}
                    </div>
                    {profile.state === 'needs-sign-in' && <span className="muted">Sign-in required</span>}
                  </div>
                  <div className="actions">
                    {!selected && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void action.run(async () => {
                            await api.selectMinecraftAccount(profile.id);
                            accounts.reload();
                          })
                        }
                      >
                        Use as default
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={disabled} onClick={() => begin(profile.id)}>
                      Reconnect
                    </Button>
                    <ConfirmAction
                      label="Remove account"
                      title={`Remove ${profile.name}?`}
                      description="The launcher will forget this profile’s sign-in. Sign in again to use it here."
                      destructive
                      disabled={disabled}
                      confirm={async () => {
                        await api.forgetMinecraftAccount(profile.id);
                        accounts.reload();
                      }}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {accounts.data && !accounts.data.persistent && accounts.data.profiles.length > 0 && (
        <p className="muted">Saved accounts are available until Launcher closes on this device.</p>
      )}
      {signingIn && (
        <div className="stack">
          {state === 'requesting' && <Pending>Requesting a Microsoft sign-in code…</Pending>}
          {state === 'saving' && <Pending>Saving your Minecraft profile…</Pending>}
          {device && (
            <div className="signin" role="status">
              <span>Enter this code in your browser. Launcher will finish signing in after you approve.</span>
              <code>{device.code}</code>
              <span className="muted">
                Expires at {new Date(device.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          )}
          <div className="actions">
            {device && (
              <Button
                disabled={cancel.pending || browser.pending}
                onClick={() => void browser.run(api.openMicrosoftSignIn)}
              >
                Open Microsoft sign-in
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={cancel.pending || state === 'saving'}
              onClick={() => void cancel.run(api.cancelMinecraftSignIn)}
            >
              Cancel sign-in
            </Button>
          </div>
        </div>
      )}
      {state === 'signed-in' && <p role="status">Microsoft sign-in completed.</p>}
      {action.pending && !signingIn && <Pending>Updating account…</Pending>}
      <Failure error={accounts.error} retry={accounts.reload} />
      <Failure error={signIn.error} retry={reloadSignIn} />
      <Failure
        error={
          action.error ??
          cancel.error ??
          (signIn.data?.state === 'failed' ? signIn.data.message : device ? browser.error : undefined)
        }
      />
    </section>
  );
}

export function MinecraftInstanceAccount({
  api,
  instance,
  running,
  refresh,
}: {
  api: Pick<DesktopApi, 'minecraftAccounts' | 'onMinecraftSignInChanged' | 'setMinecraftSettings'>;
  instance: Instance;
  running: boolean;
  refresh: () => void;
}) {
  const id = useId();
  const action = useAction();
  const remote = useRemote(api.minecraftAccounts);
  const reload = remote.reload;
  useEffect(() => api.onMinecraftSignInChanged(reload), [api, reload]);
  const selected = instance.minecraft?.settings?.accountId;
  const profiles = remote.data?.profiles ?? [];
  const current = profiles.find((profile) => profile.id === remote.data?.activeId);
  const missing = !!selected && !!remote.data && !profiles.some((profile) => profile.id === selected);
  const defaultAccount = 'default';
  const items = [
    { value: defaultAccount, label: current ? `Default (${current.name})` : 'Default account' },
    ...profiles.map((profile) => ({ value: `profile:${profile.id}`, label: profile.name })),
  ];
  return (
    <section className="section stack" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Instance account</h2>
      <Field>
        <FieldLabel htmlFor={id}>Use account for this instance</FieldLabel>
        <Select
          items={items}
          value={selected && !missing ? `profile:${selected}` : missing ? null : defaultAccount}
          disabled={running || action.pending || !remote.data}
          onValueChange={(value) => {
            if (!value) return;
            void action.run(async () => {
              await api.setMinecraftSettings(instance.id, {
                accountId: value === defaultAccount ? null : value.slice('profile:'.length),
              });
              refresh();
            });
          }}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Choose an account" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {missing && <Failure error="The saved account was removed. Choose another account or use the default." />}
      {!selected && remote.data && !current && (
        <p className="muted">Sign in or choose a default account from Overview.</p>
      )}
      <Failure error={remote.error} retry={remote.reload} />
      <Failure error={action.error} />
    </section>
  );
}
