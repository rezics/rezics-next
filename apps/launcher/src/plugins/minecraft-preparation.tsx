import {
  isActiveMinecraftPreparation,
  type Instance,
  type MinecraftPreparation,
  type MinecraftPreparationMode,
  type MinecraftPreparationPhase,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Progress } from '@rezics/ui/shadcn/progress';
import { useCallback, useEffect, useState } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';

const phaseLabel: Record<MinecraftPreparationPhase, string> = {
  queued: 'Waiting for shared game files…',
  'waiting-for-game': 'Waiting for Minecraft to close…',
  version: 'Checking Minecraft version…',
  loader: 'Preparing mod loader…',
  libraries: 'Checking libraries…',
  assets: 'Checking game assets…',
  java: 'Checking Java runtime…',
  worlds: 'Preparing worlds…',
  verify: 'Verifying installation…',
};

export type ReadPreparationApi = Pick<DesktopApi, 'readMinecraftPreparation' | 'cancelMinecraftPreparation'>;

export function useMinecraftPreparation(
  api: ReadPreparationApi,
  instanceId: string,
  live: MinecraftPreparation | undefined,
) {
  const load = useCallback(() => api.readMinecraftPreparation(instanceId), [api, instanceId]);
  const { data, error, pending, reload } = useRemote(load);
  const attempt = live ?? (data?.instanceId === instanceId ? data : null);
  return { attempt, active: isActiveMinecraftPreparation(attempt), error: live ? undefined : error, pending, reload };
}

export function useMinecraftPreparations(
  api: Pick<DesktopApi, 'readMinecraftPreparationActivity' | 'onMinecraftPreparation'>,
  reloadInstances: () => void,
) {
  const [attempts, setAttempts] = useState(() => new Map<string, MinecraftPreparation>());
  useEffect(() => {
    let subscribed = true;
    const received = new Set<string>();
    const unsubscribe = api.onMinecraftPreparation((attempt) => {
      if (!subscribed) return;
      received.add(attempt.instanceId);
      setAttempts((previous) => new Map(previous).set(attempt.instanceId, attempt));
      if (attempt.state === 'ready') reloadInstances();
    });
    void api.readMinecraftPreparationActivity().then(
      (snapshot) => {
        if (!subscribed) return;
        // A phase or terminal event observed during the request is newer than its snapshot.
        const initial = snapshot.filter(({ instanceId }) => !received.has(instanceId));
        setAttempts(
          (previous) => new Map([...previous, ...initial.map((attempt) => [attempt.instanceId, attempt] as const)]),
        );
        reloadInstances();
      },
      () => {},
    );
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [api, reloadInstances]);
  return attempts;
}

function preparationStatus(attempt: MinecraftPreparation) {
  if (attempt.state === 'cancelling') return 'Cancelling preparation…';
  if (attempt.state === 'cancelled') return 'Cancelled';
  if (attempt.interrupted) return 'Interrupted';
  if (attempt.state === 'failed') return 'Failed';
  if (attempt.state === 'ready') return 'Ready';
  return phaseLabel[attempt.phase];
}

export function PreparationProgress({ attempt }: { attempt: MinecraftPreparation }) {
  return (
    <div className="grid min-w-0 gap-2">
      <Pending>{preparationStatus(attempt)}</Pending>
      <ResourceProgress attempt={attempt} />
    </div>
  );
}

const number = new Intl.NumberFormat();

function ResourceProgress({ attempt }: { attempt: MinecraftPreparation }) {
  const { phase, progress } = attempt;
  if (!progress || (phase !== 'assets' && phase !== 'libraries')) return null;
  const resource = phase === 'assets' ? 'game assets' : 'libraries';
  const { completed, total } = progress;
  const count = `${number.format(completed)} of ${number.format(total)} ${resource} checked`;
  return (
    <Progress
      aria-label={`Minecraft ${resource} progress`}
      aria-valuetext={count}
      value={completed}
      max={total}
      className="gap-1"
    >
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
    </Progress>
  );
}

const operations: Record<MinecraftPreparationMode, string> = {
  install: 'Install',
  repair: 'Repair',
  upgrade: 'Change version',
};

export function MinecraftPreparationActivity({
  api,
  active,
  interrupted,
  recent,
  instances,
  open,
}: {
  api: Pick<DesktopApi, 'cancelMinecraftPreparation'>;
  active: MinecraftPreparation[];
  interrupted: MinecraftPreparation[];
  recent: MinecraftPreparation | undefined;
  instances: Instance[];
  open: (instance: Instance, mode: MinecraftPreparationMode) => void;
}) {
  const [dismissed, dismiss] = useState(() => new Set<string>());
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  const recoverable = interrupted
    .filter(({ id, instanceId }) => !dismissed.has(id) && byId.has(instanceId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const visible = [...active, ...recoverable];
  if (recent && !dismissed.has(recent.id)) visible.push(recent);
  if (!visible.length) return null;
  return (
    <section className="grid gap-2" aria-labelledby="preparation-activity-heading">
      <h2 id="preparation-activity-heading" className="px-2 text-xs font-semibold">
        Minecraft preparation
      </h2>
      <ul className="grid gap-2">
        {visible.map((attempt) => {
          const instance = byId.get(attempt.instanceId);
          return (
            <PreparationActivityRow
              key={attempt.id}
              api={api}
              instance={instance}
              attempt={attempt}
              open={open}
              dismiss={() => dismiss((previous) => new Set(previous).add(attempt.id))}
            />
          );
        })}
      </ul>
    </section>
  );
}

function PreparationActivityRow({
  api,
  attempt,
  instance,
  open,
  dismiss,
}: {
  api: Pick<DesktopApi, 'cancelMinecraftPreparation'>;
  attempt: MinecraftPreparation;
  instance: Instance | undefined;
  open: (instance: Instance, mode: MinecraftPreparationMode) => void;
  dismiss: () => void;
}) {
  const cancel = useAction();
  const name = instance?.name ?? 'Minecraft instance';
  return (
    <li aria-label={name} className="grid min-w-0 gap-2 rounded-md bg-card p-2">
      <Button
        size="sm"
        variant="ghost"
        className="h-auto min-w-0 justify-start px-0 whitespace-normal [overflow-wrap:anywhere]"
        disabled={!instance}
        onClick={() => {
          if (instance) open(instance, attempt.mode);
        }}
      >
        {name}
      </Button>
      <p role="status" className="text-xs text-muted-foreground">
        {operations[attempt.mode]} · {preparationStatus(attempt)}
      </p>
      {isActiveMinecraftPreparation(attempt) && <ResourceProgress attempt={attempt} />}
      {isActiveMinecraftPreparation(attempt) ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="outline"
          disabled={cancel.pending || !attempt.cancellable}
          onClick={() => void cancel.run(() => api.cancelMinecraftPreparation(attempt.instanceId, attempt.id))}
        >
          Cancel
        </Button>
      ) : (
        <Button className="justify-self-start" size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      )}
      <Failure error={cancel.error} />
    </li>
  );
}

export function MinecraftPreparationPanel({
  api,
  instanceId,
  prepared,
  running,
  preparation,
}: {
  api: ReadPreparationApi & Pick<DesktopApi, 'startMinecraftPreparation'>;
  instanceId: string;
  prepared: boolean;
  running: boolean;
  preparation: MinecraftPreparation | undefined;
}) {
  const { attempt, active, error, pending, reload } = useMinecraftPreparation(api, instanceId, preparation);
  const action = useAction();
  const install = attempt?.mode !== 'upgrade' ? attempt : null;
  const previousMode = install?.mode;
  const retry =
    (previousMode === 'install' || previousMode === 'repair') &&
    (install?.state === 'failed' || install?.state === 'cancelled');
  const mode: Exclude<MinecraftPreparationMode, 'upgrade'> = retry ? previousMode : prepared ? 'repair' : 'install';
  const startLabel = mode === 'repair' ? 'Verify and repair' : 'Prepare Minecraft';

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="minecraft-preparation-heading">
      <h2 id="minecraft-preparation-heading" className="text-base font-semibold" tabIndex={-1}>
        Installation
      </h2>
      {!attempt && pending && <Pending>Reading installation status…</Pending>}
      <Failure error={error} retry={reload} />
      <Failure error={action.error} />
      {install?.state === 'failed' && <Failure error={install.error ?? 'Game preparation failed.'} />}
      {install?.state === 'cancelled' && (
        <p className="text-sm text-muted-foreground" role="status">
          Preparation cancelled. A retry can reuse verified downloads.
        </p>
      )}
      {install?.state === 'ready' && prepared && (
        <p className="text-sm text-muted-foreground" role="status">
          Last installation check passed.
        </p>
      )}
      {active && attempt && <PreparationProgress attempt={attempt} />}
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button
            variant="outline"
            size="sm"
            disabled={action.pending || !attempt?.cancellable}
            onClick={() =>
              void action.run(async () => {
                if (attempt) await api.cancelMinecraftPreparation(instanceId, attempt.id);
              })
            }
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant={prepared ? 'outline' : 'default'}
            size="sm"
            disabled={running || action.pending || (pending && !attempt)}
            onClick={() => void action.run(() => api.startMinecraftPreparation(instanceId, mode))}
          >
            {retry ? (mode === 'repair' ? 'Retry repair' : 'Retry preparation') : startLabel}
          </Button>
        )}
        {running && !active && <p className="text-sm text-muted-foreground">Close Minecraft to check its files.</p>}
      </div>
    </section>
  );
}
