import {
  isEarlierMinecraftRelease,
  minecraftInPlaceUpgradeMessages,
  minecraftLoaderNames,
  minecraftLoaderVersion,
  sameMinecraftSelection,
  type Instance,
  type MinecraftJavaPolicy,
  type MinecraftPreparation,
  type MinecraftSelection,
  type MinecraftUpgradeMode,
  type MinecraftWorldVersionRisk,
} from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useCallback, useId, useState } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import { ConfirmAction } from '../renderer/confirm-action';
import {
  exactSelection,
  MinecraftSelectionFields,
  type MinecraftCatalogueApi,
  type MinecraftSelectionDraft,
} from '../renderer/minecraft-versions';
import type { DesktopApi } from '../shared/desktop';
import { MinecraftJavaChoice } from './minecraft-java-choice';
import { PreparationProgress, type ReadPreparationApi, useMinecraftPreparation } from './minecraft-preparation';
import {
  MinecraftWorldCopyReviewDialog,
  MinecraftWorldSelection,
  useMinecraftWorldCopyReview,
  useMinecraftWorlds,
} from './minecraft-world-selection';

export type MinecraftUpgradeApi = MinecraftCatalogueApi &
  ReadPreparationApi &
  Pick<
    DesktopApi,
    | 'readMinecraftInPlaceUpgradeBlocker'
    | 'previewMinecraftWorldCopy'
    | 'startMinecraftUpgrade'
    | 'chooseMinecraftUpgradeJava'
    | 'listInstances'
    | 'listMinecraftWorlds'
  >;

const copyWorldOptions = [
  { value: 'all', label: 'All worlds' },
  { value: 'selected', label: 'Selected worlds' },
  { value: 'none', label: 'No worlds' },
] as const;

type CopyWorldChoice = (typeof copyWorldOptions)[number]['value'];

function savedCopyWorldChoice(worldIds: readonly string[] | undefined): CopyWorldChoice {
  if (worldIds === undefined) return 'all';
  return worldIds.length > 0 ? 'selected' : 'none';
}

function versionLabel(selection: MinecraftSelection) {
  return [`Minecraft ${selection.version}`, minecraftLoaderNames[selection.loader], minecraftLoaderVersion(selection)]
    .filter(Boolean)
    .join(' ');
}

export function MinecraftUpgradePanel({
  api,
  instance,
  running,
  preparation,
  openInstance,
}: {
  api: MinecraftUpgradeApi;
  instance: Instance & { minecraft: NonNullable<Instance['minecraft']> };
  running: boolean;
  preparation: MinecraftPreparation | undefined;
  openInstance: (instance: Instance) => void;
}) {
  const id = useId();
  const current = instance.minecraft;
  const [draft, setDraft] = useState<MinecraftSelectionDraft>();
  const [worldChoice, setWorldChoice] = useState<CopyWorldChoice>();
  const [worldDraft, setSelectedWorlds] = useState<string[]>();
  const [javaChoice, setJavaChoice] = useState<MinecraftJavaPolicy | null>();
  const { attempt, active, error, pending, reload } = useMinecraftPreparation(api, instance.id, preparation);
  const upgrade = attempt?.mode === 'upgrade' ? attempt : null;
  const unfinished = upgrade?.state !== 'ready' ? upgrade : null;
  const requested = unfinished?.selection ?? current;
  const value = draft ?? {
    version: requested.version,
    loader: requested.loader,
    loaderVersion: minecraftLoaderVersion(requested),
  };
  const selection = exactSelection(value);
  const matchingRequest =
    selection && unfinished?.selection && sameMinecraftSelection(selection, unfinished.selection)
      ? unfinished
      : undefined;
  const lastCopy = matchingRequest?.upgradeMode === 'copy' ? matchingRequest : undefined;
  const downgrade = isEarlierMinecraftRelease(value.version, current.version);
  const defaultWorlds = downgrade ? 'none' : 'all';
  const copyWorlds = worldChoice ?? (lastCopy ? savedCopyWorldChoice(lastCopy.worldIds) : defaultWorlds);
  const selectedWorlds = worldDraft ?? lastCopy?.worldIds ?? [];
  const java = javaChoice === undefined ? matchingRequest?.java : (javaChoice ?? undefined);
  const runtime = java ?? current.settings?.java;
  const retry = upgrade && (upgrade.state === 'failed' || upgrade.state === 'cancelled');
  const resultId = upgrade?.state === 'ready' ? upgrade.resultInstanceId : undefined;
  const action = useAction();
  const worldReview = useMinecraftWorldCopyReview(api);
  const disabled = running || active || action.pending || (pending && !attempt);
  const changed = selection !== undefined && !sameMinecraftSelection(selection, current);
  const inventory = useMinecraftWorlds(api, changed && copyWorlds === 'selected' ? instance.id : undefined);
  const targetVersion = changed && !running && !active ? selection.version : undefined;
  const checkInPlace = useCallback(
    async () =>
      targetVersion === undefined
        ? undefined
        : { version: targetVersion, blocker: await api.readMinecraftInPlaceUpgradeBlocker(instance.id, targetVersion) },
    [api, instance.id, targetVersion],
  );
  const inPlace = useRemote(checkInPlace);
  const checked = inPlace.data?.version === targetVersion ? inPlace.data : undefined;
  const applyDisabled = disabled || !checked || checked.blocker !== null || inPlace.pending || !!inPlace.error;
  const copyDisabled = disabled || !changed || (copyWorlds === 'selected' && selectedWorlds.length === 0);
  const copyLabel = downgrade ? 'Prepare downgraded copy' : 'Prepare upgraded copy';
  const downgradeResult = upgrade?.selection && isEarlierMinecraftRelease(upgrade.selection.version, current.version);

  async function start(
    selection: MinecraftSelection,
    mode: MinecraftUpgradeMode,
    java: MinecraftJavaPolicy | undefined,
    worldIds?: readonly string[],
    confirmation?: MinecraftWorldVersionRisk,
  ) {
    await api.startMinecraftUpgrade(instance.id, selection, mode, worldIds, confirmation, java);
  }

  function reviewCopy(
    selection: MinecraftSelection,
    worldIds: readonly string[] | undefined,
    label: string,
    java: MinecraftJavaPolicy | undefined,
  ) {
    return worldReview.review({
      instance,
      targetVersion: selection.version,
      worldIds,
      label,
      copy: (confirmation) => start(selection, 'copy', java, worldIds, confirmation),
    });
  }

  async function prepareCopy() {
    if (!selection) return;
    const worldIds = copyWorlds === 'all' ? undefined : copyWorlds === 'none' ? [] : selectedWorlds;
    await reviewCopy(selection, worldIds, downgrade ? copyLabel : 'Prepare separate copy', java);
  }

  return (
    <section className="section stack" aria-labelledby="minecraft-version-change-heading">
      <h2 id="minecraft-version-change-heading" tabIndex={-1}>
        Change Minecraft version
      </h2>
      <MetaLine items={[`Current · ${versionLabel(current)}`]} />
      <FieldGroup className="max-w-md">
        <MinecraftSelectionFields
          api={api}
          id={id}
          value={value}
          disabled={disabled}
          change={(next) => {
            if (next.version !== value.version) setJavaChoice(undefined);
            if (downgrade !== isEarlierMinecraftRelease(next.version, current.version)) {
              setWorldChoice(undefined);
              setSelectedWorlds(undefined);
            }
            setDraft(next);
          }}
        />
      </FieldGroup>
      <p className="text-sm text-muted-foreground">
        Prepare a separate copy to test a version while keeping your original worlds and mods. Applying a version to
        this instance requires an instance without mods or a pack and creates a world backup.
      </p>
      {changed && !active && !running && (
        <FieldGroup className="max-w-md">
          <MinecraftJavaChoice
            legend="Java for selected version"
            runtime={runtime}
            disabled={disabled}
            choose={{
              label: 'Choose Java for this change',
              run: () =>
                void action.run(async () => {
                  const selected = await api.chooseMinecraftUpgradeJava(instance.id, value.version);
                  if (selected) setJavaChoice(selected);
                }),
            }}
            managed={{ label: 'Use managed Java for this change', run: () => setJavaChoice({ kind: 'managed' }) }}
            {...(java && { useCurrent: () => setJavaChoice(null) })}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-copy-worlds`}>
              {downgrade ? 'Worlds in downgraded copy' : 'Worlds in upgraded copy'}
            </FieldLabel>
            <Select
              items={copyWorldOptions}
              value={copyWorlds}
              disabled={disabled}
              onValueChange={(value) => {
                if (value) setWorldChoice(value);
              }}
            >
              <SelectTrigger id={`${id}-copy-worlds`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {copyWorldOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {copyWorlds === 'selected' && (
            <MinecraftWorldSelection
              worlds={inventory}
              instance={instance}
              selected={selectedWorlds}
              disabled={disabled}
              required
              downgrade={downgrade}
              setSelected={setSelectedWorlds}
            />
          )}
        </FieldGroup>
      )}
      {targetVersion !== undefined && (
        <>
          <Failure error={inPlace.error} retry={inPlace.reload} />
          {inPlace.pending && <Pending>Checking whether this instance can change versions…</Pending>}
          {!inPlace.pending && !inPlace.error && checked?.blocker && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground" role="status">
                {minecraftInPlaceUpgradeMessages[checked.blocker]}
              </p>
              <Button className="justify-self-start" size="sm" variant="outline" onClick={inPlace.reload}>
                Check again
              </Button>
            </div>
          )}
        </>
      )}
      {running && <p className="muted">Close Minecraft before changing versions.</p>}
      {upgrade?.selection && (
        <MetaLine
          items={[
            `Last request · ${versionLabel(upgrade.selection)}`,
            ...(upgrade.java ? [upgrade.java.kind === 'managed' ? 'Managed Java' : 'Custom Java'] : []),
            ...(upgrade.upgradeMode === 'copy'
              ? [
                  upgrade.worldIds === undefined
                    ? 'All worlds'
                    : upgrade.worldIds.length === 0
                      ? 'No worlds'
                      : `${upgrade.worldIds.length} selected ${upgrade.worldIds.length === 1 ? 'world' : 'worlds'}`,
                ]
              : []),
          ]}
        />
      )}
      <Failure error={error} retry={reload} />
      <Failure error={action.error} />
      {upgrade?.state === 'failed' && <Failure error={upgrade.error ?? 'The version change failed.'} />}
      {upgrade?.state === 'cancelled' && (
        <p role="status" className="muted">
          Version change cancelled.
        </p>
      )}
      {attempt && active && <PreparationProgress attempt={attempt} />}
      {upgrade?.state === 'ready' && (
        <p role="status" className="muted">
          {resultId && resultId !== instance.id
            ? downgradeResult
              ? 'Downgraded copy is ready.'
              : 'Upgraded copy is ready.'
            : 'Version verified and applied.'}
        </p>
      )}
      <div className="actions">
        {upgrade && active ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!upgrade.cancellable || action.pending}
            onClick={() => void action.run(() => api.cancelMinecraftPreparation(instance.id, upgrade.id))}
          >
            Cancel version change
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={copyDisabled} onClick={() => void action.run(prepareCopy)}>
              {copyLabel}
            </Button>
            <ConfirmAction
              label="Apply to this instance"
              title="Change this instance’s version?"
              description="Launcher will verify the selected version and back up existing worlds. Minecraft determines which worlds the selected version can open."
              disabled={applyDisabled}
              confirm={async () => {
                if (selection) await start(selection, 'in-place', java);
              }}
            />
            {retry && upgrade.selection && upgrade.upgradeMode && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  const { selection, upgradeMode, worldIds, java } = upgrade;
                  if (selection && upgradeMode) {
                    void action.run(() =>
                      upgradeMode === 'copy'
                        ? reviewCopy(selection, worldIds, 'Retry last version change', java)
                        : start(selection, upgradeMode, java),
                    );
                  }
                }}
              >
                Retry last version change
              </Button>
            )}
            {resultId && resultId !== instance.id && (
              <Button
                size="sm"
                variant="outline"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    const result = (await api.listInstances()).find(({ id }) => id === resultId);
                    if (!result) throw new Error('Find the upgraded copy in the library or archive.');
                    openInstance(result);
                  })
                }
              >
                {downgradeResult ? 'Open downgraded copy' : 'Open upgraded copy'}
              </Button>
            )}
          </>
        )}
      </div>
      <MinecraftWorldCopyReviewDialog
        warning={worldReview.warning}
        close={worldReview.dismiss}
        confirm={(work) => void action.run(work)}
      />
    </section>
  );
}
