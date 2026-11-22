import {
  isEarlierMinecraftRelease,
  minecraftLoaderNames,
  minecraftLoaderVersion,
  sameMinecraftSelection,
  type Instance,
  type LaunchIssue,
  type MinecraftCustomJava,
  type MinecraftSelection,
  type ModrinthPackPreview,
  type ModrinthPackRelease,
} from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import type { DesktopApi, DesktopPackPreview, PackDestination } from '../shared/desktop';
import { MinecraftJavaChoice } from './minecraft-java-choice';
import {
  MinecraftWorldCopyReviewDialog,
  MinecraftWorldSelection,
  useMinecraftWorldCopyReview,
  useMinecraftWorlds,
} from './minecraft-world-selection';
import { ModrinthPackBrowser, type PackBrowserApi } from './modrinth-pack-browser';

export type PackImportApi = PackBrowserApi &
  Pick<
    DesktopApi,
    | 'previewModrinthPack'
    | 'previewOnlineModrinthPack'
    | 'cancelModrinthPackPreview'
    | 'chooseModrinthPackJava'
    | 'importModrinthPack'
    | 'cancelModrinthPackInstallation'
    | 'listMinecraftWorlds'
    | 'previewMinecraftWorldCopy'
  >;
type PackApi = PackImportApi &
  Pick<DesktopApi, 'currentModrinthPack' | 'exportModrinthPack' | 'repairModrinthPack' | 'onModFolderChanged'>;
type PackPhase = 'reading' | 'downloading' | 'applying' | 'migrating';
const phaseLabel: Record<PackPhase, string> = {
  reading: 'Reading pack…',
  downloading: 'Downloading and verifying the pack archive…',
  applying: 'Installing the verified pack…',
  migrating: 'Installing the verified pack and copying selected worlds…',
};

function packLane(selection: MinecraftSelection) {
  return [
    `Minecraft ${selection.version}`,
    [minecraftLoaderNames[selection.loader], minecraftLoaderVersion(selection)].filter(Boolean).join(' '),
  ];
}

function PackContents({ pack }: { pack: ModrinthPackPreview }) {
  const [showFiles, setShowFiles] = useState(false);
  const required = pack.files.filter((file) => file.client === 'required').length;
  const skipped = pack.files.length - required;
  return (
    <div className="grid min-w-0 gap-2 rounded-lg border p-3">
      <h3 className="wrap-anywhere text-sm font-semibold">{pack.name}</h3>
      <MetaLine items={[pack.versionId, ...packLane(pack.selection)]} />
      {pack.summary && <p className="wrap-anywhere text-sm text-muted-foreground">{pack.summary}</p>}
      <details onToggle={(event) => setShowFiles(event.currentTarget.open)}>
        <summary className="cursor-pointer rounded-sm text-sm focus-visible:ring-2 focus-visible:ring-ring">
          {required} downloads · {pack.overrides.length} overrides{skipped > 0 && ` · ${skipped} skipped`}
        </summary>
        {showFiles && (
          <ul className="mt-2 grid max-h-56 gap-1 overflow-y-auto pr-1 text-sm" aria-label="Pack files">
            {pack.files.map((file) => (
              <li key={file.path} className="flex flex-wrap items-center gap-2 wrap-anywhere">
                <span className="min-w-0">{file.path}</span>
                <Badge variant="outline">{file.client === 'required' ? 'Download' : `Skipped · ${file.client}`}</Badge>
              </li>
            ))}
            {pack.overrides.map((file) => (
              <li key={`${file.kind}:${file.path}`} className="flex flex-wrap items-center gap-2 wrap-anywhere">
                <span className="min-w-0">{file.path}</span>
                <Badge variant="outline">{file.kind === 'client' ? 'Client override' : 'Shared override'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

export function PackImport({
  api,
  instance,
  done,
  cancel,
}: {
  api: PackImportApi;
  instance?: Instance;
  done: (instance: Instance) => void;
  cancel: () => void;
}) {
  const [selected, setSelected] = useState<DesktopPackPreview | null>(null);
  const [phase, setPhase] = useState<PackPhase>();
  const [browsing, setBrowsing] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [worldIds, setWorldIds] = useState<string[]>([]);
  const [java, setJava] = useState<MinecraftCustomJava>();
  const [installation, setInstallation] = useState<{ id: string; stop?: 'cancelling' | 'finishing' }>();
  const [cancelled, setCancelled] = useState(false);
  const hasPreview = useRef(false);
  const mounted = useRef(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const action = useAction();
  const stop = useAction();
  const worldReview = useMinecraftWorldCopyReview(api);
  const compatible =
    !instance?.minecraft || !selected || sameMinecraftSelection(instance.minecraft, selected.preview.selection);
  const separateInstance = !instance || !compatible || separate;
  const worldInventory = useMinecraftWorlds(api, selected && separateInstance ? instance?.id : undefined);
  const copyWorlds = separateInstance && worldIds.length > 0;
  const destination: PackDestination | undefined = copyWorlds
    ? { kind: 'copy-worlds', worldIds }
    : separateInstance
      ? 'new-instance'
      : undefined;
  const installLabel = cancelled
    ? 'Retry installation'
    : copyWorlds
      ? 'Import with selected worlds'
      : separateInstance
        ? 'Import as new instance'
        : 'Apply pack';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (hasPreview.current) void api.cancelModrinthPackPreview().catch(() => {});
    };
  }, [api]);

  useEffect(() => {
    if (cancelled && !action.pending) retryButton.current?.focus();
  }, [cancelled, action.pending]);

  function discard() {
    if (!hasPreview.current) return;
    hasPreview.current = false;
    void api.cancelModrinthPackPreview().catch(() => {});
  }

  function choose(release?: ModrinthPackRelease) {
    void action.run(async () => {
      setSelected(null);
      setCancelled(false);
      setSeparate(false);
      setWorldIds([]);
      setJava(undefined);
      setPhase(release ? 'downloading' : 'reading');
      hasPreview.current = true;
      try {
        const preview = release
          ? await api.previewOnlineModrinthPack(release.projectId, release.id, instance?.id)
          : await api.previewModrinthPack(instance?.id);
        if (!mounted.current) return;
        if (preview) setBrowsing(false);
        setSelected(preview);
      } finally {
        setPhase(undefined);
      }
    });
  }

  async function install(pack: DesktopPackPreview, target: PackDestination | undefined) {
    const attemptId = crypto.randomUUID();
    setCancelled(false);
    setInstallation({ id: attemptId });
    setPhase(typeof target === 'object' ? 'migrating' : 'applying');
    try {
      const installed = await api.importModrinthPack(pack.token, target, attemptId, target !== undefined && !!java);
      if (!mounted.current) return;
      if (!installed) {
        setCancelled(true);
        return;
      }
      hasPreview.current = false;
      done(installed);
    } finally {
      setInstallation(undefined);
      setPhase(undefined);
    }
  }

  function reviewInstallation(pack: DesktopPackPreview) {
    void action.run(async () => {
      if (!instance || typeof destination !== 'object') return install(pack, destination);
      await worldReview.review({
        instance,
        targetVersion: pack.preview.selection.version,
        worldIds: destination.worldIds,
        label: installLabel,
        copy: (confirmation) =>
          install(pack, { ...destination, ...(confirmation && { worldVersionConfirmation: confirmation }) }),
      });
    });
  }

  const Heading = instance ? 'h2' : 'h1';
  return (
    <section className="form-panel grid gap-3" aria-label="Import Modrinth pack">
      <Heading>{instance ? 'Apply a Modrinth pack' : 'Import Modrinth pack'}</Heading>
      {browsing && <ModrinthPackBrowser api={api} disabled={action.pending} select={choose} />}
      {selected && <PackContents key={selected.token} pack={selected.preview} />}
      {selected && !separateInstance && (
        <p className="text-sm text-muted-foreground">
          Your custom settings stay in place. The pack applies defaults to new settings files and unchanged pack
          settings.
        </p>
      )}
      {!compatible && (
        <Failure error="This pack requires a different Minecraft or loader version. Import it as a new instance." />
      )}
      {selected && separateInstance && (
        <MinecraftJavaChoice
          legend="Java for new instance"
          runtime={java}
          disabled={action.pending}
          choose={{
            label: 'Choose Java for this pack',
            run: () =>
              void action.run(async () => {
                const executable = await api.chooseModrinthPackJava(selected.token);
                if (executable) setJava(executable);
              }),
          }}
          managed={{ label: 'Use managed Java for this pack', run: () => setJava(undefined) }}
        />
      )}
      {instance && selected && separateInstance && (
        <MinecraftWorldSelection
          worlds={worldInventory}
          instance={instance}
          selected={worldIds}
          setSelected={setWorldIds}
          disabled={action.pending}
          downgrade={Boolean(
            instance.minecraft &&
            isEarlierMinecraftRelease(selected.preview.selection.version, instance.minecraft.version),
          )}
        />
      )}
      <Failure error={action.error} />
      {installation && <Failure error={stop.error} />}
      {cancelled && (
        <p className="text-sm text-muted-foreground" role="status">
          Installation cancelled. You can retry from this preview.
        </p>
      )}
      {phase && (
        <Pending>
          {installation?.stop === 'cancelling'
            ? 'Cancelling and cleaning up…'
            : installation?.stop === 'finishing'
              ? 'Finishing installation…'
              : phaseLabel[phase]}
        </Pending>
      )}
      <div className="actions">
        <Button
          type="button"
          variant={selected ? 'outline' : 'default'}
          disabled={action.pending}
          onClick={() => choose()}
        >
          {selected ? 'Choose another pack' : 'Choose .mrpack file'}
        </Button>
        {!browsing && (
          <Button
            type="button"
            variant="outline"
            disabled={action.pending}
            onClick={() => {
              discard();
              setSelected(null);
              setCancelled(false);
              setSeparate(false);
              setWorldIds([]);
              setJava(undefined);
              setBrowsing(true);
            }}
          >
            Browse Modrinth
          </Button>
        )}
        {instance && selected && compatible && (
          <Button
            variant="outline"
            disabled={action.pending}
            onClick={() => {
              setSeparate(!separate);
              setWorldIds([]);
            }}
          >
            {separate ? 'Use this instance' : 'Import into a separate instance'}
          </Button>
        )}
        {selected && (
          <Button ref={retryButton} disabled={action.pending} onClick={() => reviewInstallation(selected)}>
            {installLabel}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={stop.pending || !!installation?.stop}
          onClick={() => {
            if (installation && selected) {
              const attemptId = installation.id;
              void stop.run(async () => {
                const accepted = await api.cancelModrinthPackInstallation(selected.token, attemptId);
                setInstallation((current) =>
                  current?.id === attemptId ? { ...current, stop: accepted ? 'cancelling' : 'finishing' } : current,
                );
              });
              return;
            }
            discard();
            cancel();
          }}
        >
          {installation ? 'Cancel installation' : 'Cancel'}
        </Button>
      </div>
      <MinecraftWorldCopyReviewDialog
        warning={worldReview.warning}
        close={worldReview.dismiss}
        confirm={(work) => void action.run(work)}
      />
    </section>
  );
}

export function MinecraftPacks({
  api,
  instance,
  running,
  resolveLaunchIssue,
  refresh,
  openInstance,
}: {
  api: PackApi;
  instance: Instance;
  running: boolean;
  resolveLaunchIssue: (kind: LaunchIssue['kind']) => Promise<void>;
  refresh: () => void;
  openInstance: (instance: Instance) => void;
}) {
  const read = useCallback(() => api.currentModrinthPack(instance.id), [api, instance.id]);
  const current = useRemote(read);
  const reload = current.reload;
  const [choosing, setChoosing] = useState(false);
  const [exported, setExported] = useState(false);
  const [verified, setVerified] = useState<number | null>();
  const [repairing, setRepairing] = useState<{ id: string; stopping?: 'cancelling' | 'finishing' }>();
  const repairAttempt = useRef<string | undefined>(undefined);
  const action = useAction();
  const stop = useAction();
  const id = instance.id;
  useEffect(
    () =>
      api.onModFolderChanged((changedId) => {
        if (changedId === id) reload();
      }),
    [api, id, reload],
  );
  useEffect(
    () => () => {
      if (repairAttempt.current) void api.cancelModrinthPackInstallation(id, repairAttempt.current).catch(() => {});
    },
    [api, id],
  );

  function repair() {
    void action.run(async () => {
      const attempt = crypto.randomUUID();
      repairAttempt.current = attempt;
      setExported(false);
      setVerified(undefined);
      setRepairing({ id: attempt });
      try {
        const count = await api.repairModrinthPack(id, attempt);
        if (count !== null) await resolveLaunchIssue('modpack');
        setVerified(count);
      } finally {
        repairAttempt.current = undefined;
        setRepairing(undefined);
      }
    });
  }

  if (choosing && !running) {
    return (
      <PackImport
        api={api}
        instance={instance}
        cancel={() => setChoosing(false)}
        done={(installed) => {
          setChoosing(false);
          current.reload();
          refresh();
          if (installed.id !== instance.id) openInstance(installed);
        }}
      />
    );
  }

  return (
    <section className="section grid gap-3" aria-label="Modrinth pack">
      <h2>Modrinth pack</h2>
      <Failure error={current.error} retry={current.reload} />
      <Failure error={action.error} />
      <Failure error={stop.error} />
      {current.pending && current.data === undefined && <Pending>Reading pack…</Pending>}
      {current.data && <PackContents pack={current.data} />}
      {current.data === null && <p className="text-sm text-muted-foreground">No Modrinth pack is installed.</p>}
      {running && <p className="text-sm text-muted-foreground">Close the game to change or export its pack.</p>}
      {exported && (
        <p className="text-sm text-muted-foreground" role="status">
          Pack exported.
        </p>
      )}
      {verified !== undefined && (
        <p className="text-sm text-muted-foreground" role="status">
          {verified === null
            ? 'Pack repair cancelled.'
            : verified === 0
              ? 'Pack files verified.'
              : `Repaired ${verified} pack ${verified === 1 ? 'file' : 'files'}.`}
        </p>
      )}
      {repairing && (
        <div className="actions">
          <Pending>
            {repairing.stopping === 'cancelling'
              ? 'Cancelling repair…'
              : repairing.stopping === 'finishing'
                ? 'Finishing repair…'
                : 'Verifying and repairing the installed pack…'}
          </Pending>
          <Button
            variant="ghost"
            disabled={stop.pending || !!repairing.stopping}
            onClick={() => {
              const attempt = repairing.id;
              void stop.run(async () => {
                const cancelled = await api.cancelModrinthPackInstallation(id, attempt);
                setRepairing((active) =>
                  active?.id === attempt ? { ...active, stopping: cancelled ? 'cancelling' : 'finishing' } : active,
                );
              });
            }}
          >
            Cancel repair
          </Button>
        </div>
      )}
      <div className="actions">
        <Button
          variant="outline"
          disabled={running || action.pending}
          onClick={() => {
            setVerified(undefined);
            setExported(false);
            setChoosing(true);
          }}
        >
          {current.data ? 'Choose a pack update' : 'Apply a pack'}
        </Button>
        {current.data && (
          <>
            <Button variant="outline" disabled={running || action.pending} onClick={repair}>
              Repair pack
            </Button>
            <Button
              variant="outline"
              disabled={running || action.pending}
              onClick={() => {
                void action.run(async () => {
                  setExported(false);
                  setVerified(undefined);
                  setExported(await api.exportModrinthPack(instance.id));
                });
              }}
            >
              Export .mrpack
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
