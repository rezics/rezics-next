import {
  minecraftLoaderNames,
  type AutomaticBackupStatus,
  type RestorePreview,
  type Snapshot,
  type VisualNovelRestoreChoice,
  type VisualNovelSaveRoot,
} from '@rezics/launcher-contract';
import { EmptyState } from '@rezics/ui/empty-state';
import { MetaLine } from '@rezics/ui/meta-line';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { Archive } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/desktop';
import { Failure, Pending, useAction, useRemote } from './actions';
import { ConfirmAction } from './confirm-action';
import { MinecraftWorldTransfers } from './world-transfers';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const integers = new Intl.NumberFormat();
const allWorlds = ':all';
const leaveInBackup = ':leave-in-backup';
const saveFolderNames: Record<VisualNovelSaveRoot, string> = {
  game: 'Game save folder',
  renpy: 'Ren’Py user saves',
  kirikiri: 'KiriKiri save folder',
  selected: 'Manually selected folder',
};

function VisualNovelRestoreFolders({
  plan,
  disabled,
  change,
}: {
  plan: NonNullable<RestorePreview['visualNovel']>;
  disabled: boolean;
  change: (choices: VisualNovelRestoreChoice[]) => void;
}) {
  const fields = useId();
  const items = [
    ...plan.destinations.map(({ id }) => ({ value: id, label: saveFolderNames[id] })),
    { value: leaveInBackup, label: 'Leave in backup' },
  ];
  return (
    <FieldGroup>
      {plan.sources.map(({ id, files, bytes }) => {
        const current = plan.choices.find(({ sourceId }) => sourceId === id);
        const field = `${fields}-${id}`;
        return (
          <Field key={id}>
            <FieldLabel htmlFor={field}>{saveFolderNames[id]} destination</FieldLabel>
            <MetaLine className="muted" items={[`${formatFileCount(files)} in backup`, formatSize(bytes)]} />
            <Select
              items={items}
              value={current ? (current.targetId ?? leaveInBackup) : null}
              disabled={disabled}
              onValueChange={(value) => {
                if (!value) return;
                const targetId = value === leaveInBackup ? null : plan.destinations.find(({ id }) => id === value)?.id;
                if (targetId === undefined) return;
                change([...plan.choices.filter(({ sourceId }) => sourceId !== id), { sourceId: id, targetId }]);
              }}
            >
              <SelectTrigger id={field}>
                <SelectValue placeholder="Choose a destination" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {items.map(({ value, label }) => (
                    <SelectItem
                      key={value}
                      value={value}
                      disabled={plan.choices.some(({ sourceId, targetId }) => sourceId !== id && targetId === value)}
                    >
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        );
      })}
    </FieldGroup>
  );
}

export function useAutomaticBackup(
  api: Pick<DesktopApi, 'automaticBackupStatus' | 'onAutomaticBackup'>,
  instanceId: string,
) {
  const [observed, setObserved] = useState<AutomaticBackupStatus>();
  useEffect(
    () =>
      api.onAutomaticBackup((id, value) => {
        if (id === instanceId) setObserved(value);
      }),
    [api, instanceId],
  );
  const initial = useRemote(useCallback(() => api.automaticBackupStatus(instanceId), [api, instanceId]));
  return { status: observed ?? initial.data, error: observed ? undefined : initial.error, reload: initial.reload };
}

export function Saves({
  instanceId,
  running,
  minecraft,
  automatic,
}: {
  instanceId: string;
  running: boolean;
  minecraft: boolean;
  automatic: ReturnType<typeof useAutomaticBackup>;
}) {
  const api = window.launcher;
  const labelId = useId();
  const scopeId = useId();
  const [label, setLabel] = useState('');
  const [world, setWorld] = useState(allWorlds);
  const [preview, setPreview] = useState<RestorePreview>();
  const [deleting, setDeleting] = useState<Snapshot>();
  const [status, setStatus] = useState('');
  const load = useCallback(() => api.readSnapshotHistory(instanceId), [api, instanceId]);
  const history = useRemote(load);
  const issues = history.data?.issues;
  const worlds = useRemote(
    useCallback(
      () => (minecraft ? api.listMinecraftWorlds(instanceId) : Promise.resolve([])),
      [api, instanceId, minecraft],
    ),
  );
  const reloadHistory = history.reload;
  const reloadWorlds = worlds.reload;
  const refresh = useCallback(() => {
    reloadHistory();
    if (minecraft) reloadWorlds();
  }, [minecraft, reloadHistory, reloadWorlds]);
  useEffect(
    () =>
      api.onSaveHistoryChanged((changedInstanceId) => {
        if (changedInstanceId === instanceId) refresh();
      }),
    [api, instanceId, refresh],
  );
  const action = useAction();
  const backupState = automatic.status?.state;
  const previousBackupState = useRef(backupState);
  useEffect(() => {
    if (previousBackupState.current === 'running' && backupState !== 'running') refresh();
    previousBackupState.current = backupState;
  }, [backupState, refresh]);
  const savesBusy = running || backupState === 'running';
  const versionRisk = preview?.minecraftVersionRisk;
  const worldAvailable = world === allWorlds || worlds.data?.some((entry) => entry.id === world);
  const scopeItems = [
    { value: allWorlds, label: 'All worlds' },
    ...(worlds.data ?? []).map(({ id, name }) => ({ value: id, label: name })),
  ];

  async function restore(from: RestorePreview) {
    if (!from.review) return;
    await api.restoreSnapshot(instanceId, from.snapshot.id, from.minecraftVersionRisk, from.review);
    setPreview(undefined);
    setStatus('Backup restored.');
    refresh();
  }

  function backup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!worldAvailable) return;
    void action.run(async () => {
      setStatus('');
      await api.createSnapshot(
        instanceId,
        label.trim() || undefined,
        minecraft && world !== allWorlds ? { kind: 'world', id: world } : undefined,
      );
      setLabel('');
      history.reload();
      setStatus('Backup created.');
    });
  }

  return (
    <section className="section stack" aria-labelledby="saves-heading">
      <div className="section-heading">
        <h2 id="saves-heading" tabIndex={-1}>
          Save history
        </h2>
        <div className="actions">
          <Button
            variant="outline"
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                setStatus('');
                const imported = await api.importSnapshot(instanceId);
                if (imported) {
                  history.reload();
                  setStatus('Backup imported. Preview it before restoring.');
                }
              })
            }
          >
            Import backup
          </Button>
          <Button variant="ghost" disabled={history.pending || (minecraft && worlds.pending)} onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>
      {running && (
        <Alert role="status">
          <AlertDescription>Close the game before changing its saves.</AlertDescription>
        </Alert>
      )}
      <form onSubmit={backup}>
        <FieldGroup className="search">
          {minecraft && (
            <Field data-disabled={savesBusy || action.pending || undefined}>
              <FieldLabel className="sr-only" htmlFor={scopeId}>
                Backup scope
              </FieldLabel>
              <Select
                items={scopeItems}
                value={world}
                disabled={savesBusy || action.pending || (worlds.pending && !worlds.data)}
                onValueChange={(item) => setWorld(item ?? allWorlds)}
              >
                <SelectTrigger id={scopeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {scopeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field data-disabled={savesBusy || action.pending || undefined}>
            <FieldLabel className="sr-only" htmlFor={labelId}>
              Backup label
            </FieldLabel>
            <Input
              id={labelId}
              name="label"
              placeholder="Backup label (optional)"
              maxLength={120}
              value={label}
              disabled={savesBusy || action.pending}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={savesBusy || action.pending || !worldAvailable}>
            <Archive aria-hidden="true" data-icon="inline-start" /> Back up
          </Button>
        </FieldGroup>
      </form>
      {minecraft && (
        <MinecraftWorldTransfers
          api={api}
          instanceId={instanceId}
          worldId={world !== allWorlds && worldAvailable ? world : undefined}
          locked={savesBusy || action.pending}
          imported={(id) => {
            reloadWorlds();
            setWorld(id);
          }}
        />
      )}
      {minecraft && <Failure error={worlds.error} retry={worlds.reload} />}
      {minecraft && !worldAvailable && !worlds.pending && (
        <Failure error="The selected world is unavailable. Choose another world or back up all worlds." />
      )}
      <Failure error={history.error} retry={history.reload} />
      <Failure error={automatic.error} retry={automatic.reload} />
      {backupState === 'running' && <Pending>Backing up saves…</Pending>}
      {automatic.status?.state === 'failed' && (
        <div className="grid gap-2">
          <Failure error={`Automatic backup failed. ${automatic.status.message}`} />
          <Button
            className="justify-self-start"
            variant="outline"
            size="sm"
            disabled={savesBusy || action.pending}
            onClick={() =>
              void action.run(async () => {
                setStatus('');
                await api.retryAutomaticBackup(instanceId);
                refresh();
                setStatus('Automatic backup complete.');
              })
            }
          >
            Retry automatic backup
          </Button>
        </div>
      )}
      {!deleting && <Failure error={action.error} />}
      {status && (
        <Alert role="status">
          <AlertDescription className="[overflow-wrap:anywhere]">{status}</AlertDescription>
        </Alert>
      )}
      {action.pending && <Pending>Working on saves…</Pending>}
      {history.pending && !history.data && <Pending>Loading save history…</Pending>}
      {issues && issues.length > 0 && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">
            {issues.length} {issues.length === 1 ? 'backup record' : 'backup records'} could not be read
          </summary>
          <ul className="mt-2 grid gap-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {issues.map(({ id, reason }) => (
              <li className="grid" key={id}>
                <code>{id}</code>
                <span>{reason === 'invalid-metadata' ? 'Invalid metadata' : 'Metadata unavailable'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {history.data?.snapshots.length === 0 && issues?.length === 0 && (
        <EmptyState density="compact" headingLevel={3} title="No local backups yet." />
      )}
      <ul className="rows">
        {history.data?.snapshots.map((snapshot) => (
          <li className="row-item" key={snapshot.id}>
            <div className="row-content">
              <SnapshotDetails snapshot={snapshot} />
              <div className="actions">
                <Button
                  variant="outline"
                  aria-expanded={preview?.snapshot.id === snapshot.id}
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      setStatus('');
                      setPreview(await api.previewRestore(instanceId, snapshot.id));
                    })
                  }
                >
                  Preview restore
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      setStatus('');
                      const pinned = !snapshot.pinned;
                      await api.setSnapshotPinned(instanceId, snapshot.id, pinned);
                      setStatus(pinned ? 'Backup pinned.' : 'Backup unpinned.');
                      history.reload();
                    })
                  }
                >
                  {snapshot.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      setStatus('');
                      const folder = await api.exportSnapshot(instanceId, snapshot.id);
                      if (folder) setStatus(`Backup exported to ${folder}`);
                    })
                  }
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.pending || snapshot.pinned}
                  onClick={() => {
                    setStatus('');
                    setDeleting(snapshot);
                  }}
                >
                  Delete…
                </Button>
              </div>
            </div>
            {preview?.snapshot.id === snapshot.id && (
              <div className="version-list stack" aria-label="Restore preview">
                <h3>Restore destinations</h3>
                {preview.visualNovel && (
                  <VisualNovelRestoreFolders
                    plan={preview.visualNovel}
                    disabled={savesBusy || action.pending}
                    change={(choices) =>
                      void action.run(async () =>
                        setPreview(await api.previewRestore(instanceId, snapshot.id, choices)),
                      )
                    }
                  />
                )}
                {versionRisk && (
                  <Alert variant="destructive">
                    <AlertDescription className="[overflow-wrap:anywhere]">
                      {versionRisk.source === 'world'
                        ? `This backup includes a world saved in Minecraft ${versionRisk.backupVersion}.`
                        : `This backup records Minecraft ${versionRisk.backupVersion}.`}{' '}
                      This instance uses Minecraft {versionRisk.targetVersion}. Opening restored worlds in the older
                      version can damage them.
                    </AlertDescription>
                  </Alert>
                )}
                <ul className="rows">
                  {preview.targets.map((target) => (
                    <li key={target.path} className="target">
                      <span>{target.path}</span>
                      <MetaLine className="muted" items={[formatFileCount(target.files), formatSize(target.bytes)]} />
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  {versionRisk ? (
                    <ConfirmAction
                      key={versionRisk.targetVersion}
                      label="Restore this backup"
                      title="Restore to an older Minecraft version?"
                      description="Opening restored worlds in the older version can damage them. Launcher backs up any live saves it replaces."
                      disabled={!preview.review || savesBusy || action.pending}
                      destructive
                      confirm={() => restore(preview)}
                    />
                  ) : (
                    <Button
                      variant="destructive"
                      disabled={!preview.review || savesBusy || action.pending}
                      onClick={() => void action.run(() => restore(preview))}
                    >
                      {preview.visualNovel?.choices.some(({ targetId }) => targetId === null)
                        ? 'Restore selected folders'
                        : 'Restore this backup'}
                    </Button>
                  )}
                  <Button variant="ghost" disabled={action.pending} onClick={() => setPreview(undefined)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <AlertDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open && !action.pending) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? backupTitle(deleting) : 'This backup'} will be removed from the save history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={action.error} />
          {action.pending && <Pending>Deleting backup…</Pending>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.pending}>Keep backup</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={action.pending}
              onClick={() => {
                if (!deleting) return;
                void action.run(async () => {
                  await api.deleteSnapshot(instanceId, deleting.id);
                  setPreview((current) => (current?.snapshot.id === deleting.id ? undefined : current));
                  setDeleting(undefined);
                  setStatus('Backup deleted.');
                  history.reload();
                });
              }}
            >
              Delete backup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function backupTitle(snapshot: Snapshot) {
  return snapshot.label || date.format(new Date(snapshot.createdAt));
}

function SnapshotDetails({ snapshot }: { snapshot: Snapshot }) {
  const created = date.format(new Date(snapshot.createdAt));
  return (
    <div className="row-text">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <strong>{backupTitle(snapshot)}</strong>
        {snapshot.pinned && <Badge variant="secondary">Pinned</Badge>}
      </div>
      <MetaLine
        className="muted"
        items={[snapshot.label && created, formatFileCount(snapshot.files), formatSize(snapshot.bytes)]}
      />
      {snapshot.minecraft && (
        <MetaLine
          className="muted"
          items={[
            snapshot.selection && `World: ${snapshot.selection.id}`,
            `Minecraft ${snapshot.minecraft.version}`,
            [minecraftLoaderNames[snapshot.minecraft.loader], snapshot.minecraft.loaderVersion]
              .filter(Boolean)
              .join(' '),
            snapshot.minecraft.mods.length > 0 && `${snapshot.minecraft.mods.length} mods`,
          ]}
        />
      )}
    </div>
  );
}

function formatFileCount(files: number) {
  return `${integers.format(files)} ${files === 1 ? 'file' : 'files'}`;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = bytes <= 0 ? 0 : Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))));
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}
