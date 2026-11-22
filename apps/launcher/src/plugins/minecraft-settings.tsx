import {
  isActiveMinecraftPreparation,
  minecraftMemoryMiB,
  type Instance,
  type MinecraftJavaStatus,
  type MinecraftPreparation,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { FolderOpen } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Failure, Pending, useAction } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';
import { MinecraftInstanceAccount } from './minecraft-account';
import { MinecraftInstanceActions, type InstanceActionsApi } from './minecraft-instances';
import { MinecraftUpgradePanel, type MinecraftUpgradeApi } from './minecraft-upgrade';

type SettingsApi = InstanceActionsApi &
  MinecraftUpgradeApi &
  Pick<
    DesktopApi,
    | 'setMinecraftSettings'
    | 'chooseMinecraftJava'
    | 'checkMinecraftJava'
    | 'openInstanceFolder'
    | 'minecraftAccounts'
    | 'onMinecraftSignInChanged'
  >;

export function MinecraftSettingsPanel({
  api,
  instance,
  running,
  preparation,
  refresh,
  openInstance,
  openArchive,
}: {
  api: SettingsApi;
  instance: Instance;
  running: boolean;
  preparation: MinecraftPreparation | undefined;
  refresh: () => void;
  openInstance: (instance: Instance) => void;
  openArchive: () => void;
}) {
  const id = useId();
  const action = useAction();
  const [memoryDraft, setMemoryDraft] = useState<string>();
  const [status, setStatus] = useState('');
  const [runtimeCheck, setRuntimeCheck] = useState<{ key: string; result: MinecraftJavaStatus }>();
  const settings = instance.minecraft?.settings;
  const java = settings?.java.kind === 'custom' ? settings.java.executable : undefined;
  const runtimeKey = JSON.stringify([instance.minecraft?.version, java, instance.minecraft?.prepared, preparation?.id]);
  const checked = runtimeCheck?.key === runtimeKey ? runtimeCheck.result : undefined;
  const savedMemory = settings?.maxMemoryMiB?.toString() ?? '';
  const memory = memoryDraft ?? savedMemory;
  const preparing = isActiveMinecraftPreparation(preparation);
  const disabled = running || preparing || action.pending;
  const memoryMiB = Number(memory);
  const memoryValid =
    memory === '' ||
    (Number.isInteger(memoryMiB) && memoryMiB >= minecraftMemoryMiB.min && memoryMiB <= minecraftMemoryMiB.max);

  function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !memoryValid || memory === savedMemory) return;
    void action.run(async () => {
      setStatus('');
      const updated = await api.setMinecraftSettings(instance.id, { maxMemoryMiB: memory === '' ? null : memoryMiB });
      setMemoryDraft(updated.minecraft?.settings?.maxMemoryMiB?.toString() ?? '');
      setStatus('Memory limit saved.');
      refresh();
    });
  }

  return (
    <div className="stack">
      <section className="section stack" aria-labelledby={`${id}-heading`}>
        <div className="section-heading">
          <h2 id={`${id}-heading`}>Instance settings</h2>
          <Button
            variant="outline"
            disabled={action.pending}
            onClick={() => void action.run(() => api.openInstanceFolder(instance.id))}
          >
            <FolderOpen aria-hidden="true" data-icon="inline-start" /> Open instance folder
          </Button>
        </div>
        {running && <p className="muted">Close Minecraft to change Java or memory.</p>}
        {preparing && <p className="muted">Wait for preparation to finish before changing Java or memory.</p>}
        <div className="grid min-w-0 gap-2">
          <h3>Java runtime</h3>
          {java ? (
            <code className="text-sm [overflow-wrap:anywhere]">{java}</code>
          ) : (
            <p className="muted">Managed Java</p>
          )}
          <div className="actions">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void action.run(async () => {
                  setStatus('');
                  if (await api.chooseMinecraftJava(instance.id)) {
                    setRuntimeCheck(undefined);
                    setStatus('Java executable saved.');
                    refresh();
                  }
                })
              }
            >
              Choose Java executable
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void action.run(async () => {
                  setStatus('');
                  setRuntimeCheck(undefined);
                  const result = await api.checkMinecraftJava(instance.id);
                  setRuntimeCheck({ key: runtimeKey, result });
                })
              }
            >
              Check Java
            </Button>
            {java && (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void action.run(async () => {
                    setStatus('');
                    await api.setMinecraftSettings(instance.id, { useManagedJava: true });
                    setRuntimeCheck(undefined);
                    setStatus('Managed Java selected.');
                    refresh();
                  })
                }
              >
                Use managed Java
              </Button>
            )}
          </div>
          {checked?.state === 'ready' && (
            <p role="status" className="muted">
              Java {checked.major} ({checked.architecture}) is ready.
            </p>
          )}
          {checked?.state === 'needs-preparation' && (
            <p role="status" className="muted">
              Prepare this instance to install Java {checked.requiredMajor}.
            </p>
          )}
          {checked?.state === 'invalid' && <Failure error={checked.message} />}
        </div>
        <form className="stack" onSubmit={saveMemory}>
          <Field data-disabled={disabled || undefined}>
            <FieldLabel htmlFor={`${id}-memory`}>Maximum memory (MiB)</FieldLabel>
            <Input
              className="max-w-40"
              id={`${id}-memory`}
              aria-describedby={`${id}-memory-help`}
              type="number"
              inputMode="numeric"
              min={minecraftMemoryMiB.min}
              max={minecraftMemoryMiB.max}
              step={1}
              value={memory}
              placeholder="Default"
              disabled={disabled}
              onChange={(event) => {
                setStatus('');
                setMemoryDraft(event.target.value);
              }}
            />
            <FieldDescription id={`${id}-memory-help`}>
              Enter {minecraftMemoryMiB.min}–{minecraftMemoryMiB.max} MiB, or leave blank for the default.
            </FieldDescription>
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={disabled || !memoryValid || memory === savedMemory}>
              Save memory limit
            </Button>
          </div>
        </form>
        {action.pending && <Pending>Updating instance settings…</Pending>}
        {status && (
          <p role="status" className="muted">
            {status}
          </p>
        )}
        <Failure error={action.error} />
      </section>
      <MinecraftInstanceAccount api={api} instance={instance} running={running || preparing} refresh={refresh} />
      {instance.minecraft && (
        <MinecraftUpgradePanel
          api={api}
          instance={{ ...instance, minecraft: instance.minecraft }}
          running={running}
          preparation={preparation}
          openInstance={openInstance}
        />
      )}
      <MinecraftInstanceActions
        api={api}
        instance={instance}
        running={running}
        refresh={refresh}
        openInstance={openInstance}
        openArchive={openArchive}
      />
    </div>
  );
}
