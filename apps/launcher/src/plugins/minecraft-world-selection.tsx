import {
  isEarlierMinecraftRelease,
  maxMinecraftWorldSelection,
  type Instance,
  type MinecraftWorldVersionRisk,
} from '@rezics/launcher-contract';
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
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useCallback, useId, useState } from 'react';
import { Failure, Pending, useRemote } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';

type WorldApi = Pick<DesktopApi, 'listMinecraftWorlds'>;
type WorldCopyReview = { label: string; description: string; confirm: () => Promise<unknown> };

export function useMinecraftWorldCopyReview(api: Pick<DesktopApi, 'previewMinecraftWorldCopy'>) {
  const [warning, setWarning] = useState<WorldCopyReview>();
  return {
    warning,
    dismiss: () => setWarning(undefined),
    async review({
      instance,
      targetVersion,
      worldIds,
      label,
      copy,
    }: {
      instance: Instance;
      targetVersion: string;
      worldIds: readonly string[] | undefined;
      label: string;
      copy: (confirmation?: MinecraftWorldVersionRisk) => Promise<unknown>;
    }) {
      if (worldIds?.length === 0) return copy();
      const risk = await api.previewMinecraftWorldCopy(instance.id, targetVersion, worldIds);
      const downgrade = instance.minecraft && isEarlierMinecraftRelease(targetVersion, instance.minecraft.version);
      if (!risk && !downgrade) return copy();
      setWarning({
        label,
        description: risk
          ? `A selected world was saved in Minecraft ${risk.worldVersion}. Opening its copy in ${risk.targetVersion} can damage it.`
          : 'Opening a copied world in an older Minecraft version can damage it. Minecraft determines which worlds can open.',
        confirm: () => copy(risk ?? undefined),
      });
    },
  };
}

export function MinecraftWorldCopyReviewDialog({
  warning,
  close,
  confirm,
}: {
  warning: WorldCopyReview | undefined;
  close: () => void;
  confirm: (work: () => Promise<unknown>) => void;
}) {
  if (!warning) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Copy worlds to an older Minecraft version?</AlertDialogTitle>
          <AlertDialogDescription>{warning.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              close();
              confirm(warning.confirm);
            }}
          >
            {warning.label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useMinecraftWorlds(api: WorldApi, instanceId: string | undefined) {
  const load = useCallback(
    () => (instanceId ? api.listMinecraftWorlds(instanceId) : Promise.resolve(undefined)),
    [api, instanceId],
  );
  return useRemote(load);
}

export function MinecraftWorldSelection({
  worlds,
  instance,
  selected,
  disabled,
  required = false,
  downgrade = false,
  setSelected,
}: {
  worlds: ReturnType<typeof useMinecraftWorlds>;
  instance: Instance;
  selected: readonly string[];
  disabled: boolean;
  required?: boolean;
  downgrade?: boolean;
  setSelected: (worldIds: string[]) => void;
}) {
  const id = useId();
  const { data, error, pending, reload } = worlds;
  return (
    <fieldset className="grid min-w-0 gap-2 rounded-lg border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">
        Copy worlds from {instance.name}
        {required ? '' : ' (optional)'}
      </legend>
      <Failure error={error} retry={reload} />
      {pending && data === undefined && <Pending>Reading worlds…</Pending>}
      {data?.length === 0 && <p className="text-sm text-muted-foreground">This instance has no worlds to copy.</p>}
      {data && data.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            {downgrade
              ? 'An older Minecraft version may damage a world saved by a newer version. Choose worlds that match the selected release.'
              : 'Minecraft determines which worlds the new version can open.'}
          </p>
          <div className="grid max-h-52 gap-2 overflow-y-auto">
            {data.map((world, index) => {
              const checked = selected.includes(world.id);
              const fieldId = `${id}-world-${index}`;
              return (
                <Field key={world.id} orientation="horizontal">
                  <Checkbox
                    id={fieldId}
                    checked={checked}
                    disabled={disabled || (!checked && selected.length >= maxMinecraftWorldSelection)}
                    onCheckedChange={(value) =>
                      setSelected(value ? [...selected, world.id] : selected.filter((entry) => entry !== world.id))
                    }
                  />
                  <FieldLabel className="min-w-0 wrap-anywhere" htmlFor={fieldId}>
                    {world.name}
                  </FieldLabel>
                </Field>
              );
            })}
          </div>
          {selected.length >= maxMinecraftWorldSelection && (
            <p className="text-sm text-muted-foreground" role="status">
              {maxMinecraftWorldSelection} worlds selected. Deselect a world to choose another.
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
