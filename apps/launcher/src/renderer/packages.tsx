import type {
  CatalogPackage,
  CatalogRelease,
  InstalledOverlayExtension,
  InstalledPackage,
  MinecraftLoader,
  MinecraftModStatePreview,
  ModrinthProject,
  PackageKind,
} from '@rezics/launcher-contract';
import { overlayPanelLimit } from '@rezics/launcher-contract';
import { EmptyState } from '@rezics/ui/empty-state';
import { MetaLine } from '@rezics/ui/meta-line';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/shadcn/tabs';
import { ArrowDown, ArrowUp, Download, Package, Search } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/desktop';
import { Failure, Pager, Pending, useAction, usePaging, useRemote } from './actions';
import { MinecraftModFolderPanel } from './minecraft-mod-folder';
import { CatalogInstallReview, ModrinthInstallReview } from './package-install-review';

export type PackagesApi = Pick<
  DesktopApi,
  | 'listInstalled'
  | 'setPackageEnabled'
  | 'uninstallPackage'
  | 'listPackages'
  | 'listReleases'
  | 'previewCatalogInstall'
  | 'installReviewedCatalogPackage'
  | 'cancelPackageInstall'
  | 'onPackageInstallProgress'
  | 'listOverlayExtensions'
  | 'repairOverlayExtension'
  | 'reorderOverlayExtensions'
  | 'searchMods'
  | 'modVersions'
  | 'previewModInstall'
  | 'installMod'
  | 'previewModState'
  | 'applyModState'
  | 'readMinecraftModFolder'
  | 'setMinecraftManualModEnabled'
  | 'openMinecraftModFolder'
  | 'onModFolderChanged'
  | 'onExtensionsChanged'
  | 'repairMod'
  | 'importMod'
>;

type PackagesProps = { api: PackagesApi } & (
  | { instanceId?: never; minecraft?: never }
  | {
      instanceId: string;
      running?: boolean;
      minecraft: { version: string; loader: Exclude<MinecraftLoader, 'vanilla'>; prepared: boolean };
    }
);
type ListedPackage = InstalledPackage &
  Partial<Pick<InstalledOverlayExtension, 'revision' | 'orderRevision' | 'visible'>>;

export function Packages(props: PackagesProps) {
  const { api, instanceId, minecraft } = props;
  const load = useCallback(
    (): Promise<ListedPackage[]> => (instanceId ? api.listInstalled(instanceId) : api.listOverlayExtensions()),
    [api, instanceId],
  );
  const installed = useRemote(load);
  const loadFolder = useCallback(
    () => (instanceId ? api.readMinecraftModFolder(instanceId) : Promise.resolve(null)),
    [api, instanceId],
  );
  const folder = useRemote(loadFolder);
  const reloadFolder = folder.reload;
  const reloadInstalled = installed.reload;
  const refreshInstalled = useCallback(() => {
    reloadInstalled();
    if (instanceId) reloadFolder();
  }, [instanceId, reloadFolder, reloadInstalled]);
  useEffect(() => {
    if (!instanceId) return api.onExtensionsChanged(refreshInstalled);
    return api.onModFolderChanged((changedInstanceId) => {
      if (changedInstanceId === instanceId) refreshInstalled();
    });
  }, [api, instanceId, refreshInstalled]);
  const action = useAction();
  const reorder = useAction();
  const loaded = installed.data ?? [];
  const orderRevision = loaded[0]?.orderRevision;
  const outsideOverlay = new Set(
    loaded.filter(({ enabled, fileIssue, visible }) => enabled && !fileIssue && visible === false).map(({ id }) => id),
  );
  const editable = !instanceId || minecraft?.prepared === true;
  const locked = 'running' in props && props.running === true;

  function moveOverlay(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (!orderRevision || installed.pending || target < 0 || target >= loaded.length) return;
    const ids = loaded.map(({ id }) => id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void reorder.run(async () => {
      try {
        await api.reorderOverlayExtensions(ids, orderRevision);
      } finally {
        reloadInstalled();
      }
    });
  }

  const modrinth = instanceId && (
    <ModrinthBrowser
      api={api}
      instanceId={instanceId}
      installed={loaded}
      locked={locked}
      onInstall={refreshInstalled}
    />
  );
  const catalog = (
    <CatalogBrowser
      api={api}
      kind={instanceId ? 'minecraft-mod' : 'overlay-panel'}
      instanceId={instanceId}
      gameVersion={minecraft?.version}
      installed={loaded}
      locked={locked}
      onInstall={refreshInstalled}
    />
  );

  return (
    <div className="stack">
      {instanceId && (
        <MinecraftModFolderPanel
          folder={folder.data}
          error={folder.error}
          pending={folder.pending}
          running={props.running ?? false}
          rescan={folder.reload}
          open={() => api.openMinecraftModFolder(instanceId)}
          setEnabled={(name, enabled, revision) =>
            api.setMinecraftManualModEnabled(instanceId, name, enabled, revision)
          }
        />
      )}
      {editable && (
        <section className="section stack" aria-labelledby="browse-packages">
          <div className="section-heading">
            <h2 id="browse-packages">{instanceId ? 'Browse mods' : 'Browse extensions'}</h2>
            {instanceId && (
              <div className="actions">
                <Button
                  variant="outline"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      if (await api.importMod(instanceId)) refreshInstalled();
                    })
                  }
                >
                  <Download aria-hidden="true" data-icon="inline-start" /> Import JAR
                </Button>
              </div>
            )}
          </div>
          <Failure error={action.error} />
          {action.pending && <Pending>Importing mod…</Pending>}
          {!instanceId && catalog}
          {minecraft?.loader === 'fabric' && (
            <Tabs defaultValue="rezics">
              <TabsList aria-label="Mod source">
                <TabsTrigger value="rezics">REZICS</TabsTrigger>
                <TabsTrigger value="modrinth">Modrinth</TabsTrigger>
              </TabsList>
              <TabsContent value="rezics">{catalog}</TabsContent>
              <TabsContent value="modrinth">{modrinth}</TabsContent>
            </Tabs>
          )}
          {minecraft && minecraft.loader !== 'fabric' && modrinth}
        </section>
      )}
      {!editable && <p className="muted">Prepare this instance to add mods.</p>}
      <section className="section stack" aria-labelledby="installed-packages">
        <div className="section-heading">
          <h2 id="installed-packages">{instanceId ? 'Installed mods' : 'Installed extensions'}</h2>
          <Button variant="ghost" disabled={installed.pending} onClick={refreshInstalled}>
            Refresh
          </Button>
        </div>
        {installed.pending && !installed.data && <Pending>Loading installed packages…</Pending>}
        <Failure error={installed.error} retry={refreshInstalled} />
        <Failure error={reorder.error} />
        {outsideOverlay.size > 0 && (
          <p className="muted">
            Overlay shows the first {overlayPanelLimit} usable enabled extensions. Move a panel up to show it earlier.
          </p>
        )}
        {installed.data && installed.data.length === 0 && (
          <EmptyState density="compact" headingLevel={3} title="Nothing installed yet." />
        )}
        <ul className="rows">
          {loaded.map((item, index) => (
            <InstalledRow
              api={api}
              key={item.id}
              item={item}
              instanceId={instanceId}
              gameVersion={minecraft?.version}
              outsideOverlay={outsideOverlay.has(item.id)}
              orderControls={
                orderRevision &&
                loaded.length > 1 && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="aria-disabled:opacity-50"
                      aria-label={`Move ${item.title} up`}
                      disabled={index === 0 || installed.pending || reorder.pending}
                      focusableWhenDisabled
                      onClick={() => moveOverlay(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="aria-disabled:opacity-50"
                      aria-label={`Move ${item.title} down`}
                      disabled={index === loaded.length - 1 || installed.pending || reorder.pending}
                      focusableWhenDisabled
                      onClick={() => moveOverlay(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </>
                )
              }
              editable={editable}
              locked={locked}
              onChange={refreshInstalled}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function InstalledRow({
  api,
  item,
  instanceId,
  gameVersion,
  outsideOverlay,
  orderControls,
  editable,
  locked,
  onChange,
}: {
  api: PackagesApi;
  item: ListedPackage;
  instanceId: string | undefined;
  gameVersion: string | undefined;
  outsideOverlay: boolean;
  orderControls: ReactNode;
  editable: boolean;
  locked: boolean;
  onChange: () => void;
}) {
  const action = useAction();
  const repair = useAction();
  const pending = action.pending || repair.pending;
  const [review, setReview] = useState<MinecraftModStatePreview>();
  const [versionsOpen, setVersionsOpen] = useState(false);
  const overlayRevision = instanceId === undefined ? item.revision : undefined;
  const toggle = useRef<HTMLButtonElement>(null);

  function closeReview() {
    setReview(undefined);
    requestAnimationFrame(() => toggle.current?.focus());
  }

  function togglePackage() {
    void action.run(async () => {
      const enabled = !item.enabled;
      if (instanceId === undefined) {
        await api.setPackageEnabled(item.id, enabled);
      } else {
        const preview = await api.previewModState(instanceId, item.id, enabled);
        if (preview.changes.length > 1) {
          setReview(preview);
          return;
        }
        if (preview.changes.length === 1) {
          await api.applyModState(instanceId, item.id, enabled, preview.revision);
        }
      }
      onChange();
    });
  }

  return (
    <li className="row-item">
      <div className="row-content">
        <Package aria-hidden="true" className="row-icon" />
        <div className="row-text">
          <strong>{item.title}</strong>
          <div className="actions">
            <MetaLine className="muted" items={[item.version, sourceLabel[item.source]]} />
            <Badge variant={item.enabled ? 'secondary' : 'outline'}>{item.enabled ? 'Enabled' : 'Disabled'}</Badge>
            {outsideOverlay && <Badge variant="outline">Outside Overlay limit</Badge>}
            {item.fileIssue && (
              <Badge variant="destructive">
                {instanceId
                  ? fileIssueLabel[item.fileIssue]
                  : item.fileIssue === 'missing'
                    ? 'Missing panel'
                    : 'Damaged panel'}
              </Badge>
            )}
          </div>
        </div>
        <div className="actions">
          {orderControls}
          {editable && item.source !== 'local' && (
            <Button
              variant="outline"
              aria-expanded={versionsOpen}
              disabled={pending || !!review}
              onClick={() => setVersionsOpen((previous) => !previous)}
            >
              Versions
            </Button>
          )}
          {instanceId && item.fileIssue && (
            <Button
              variant="outline"
              disabled={locked || pending || !!review || item.fileIssue === 'unavailable'}
              onClick={() =>
                void repair.run(async () => {
                  if (await api.repairMod(instanceId, item.id, item.source === 'local')) onChange();
                })
              }
            >
              {item.source === 'local' ? 'Choose original JAR' : 'Repair mod'}
            </Button>
          )}
          {overlayRevision && item.fileIssue && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void repair.run(async () => {
                  await api.repairOverlayExtension(item.id, overlayRevision);
                  onChange();
                })
              }
            >
              Repair extension
            </Button>
          )}
          <Button
            ref={toggle}
            variant="outline"
            disabled={locked || pending || !!review || (!item.enabled && Boolean(item.fileIssue))}
            onClick={togglePackage}
          >
            {item.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="ghost"
            disabled={locked || pending || !!review}
            onClick={() =>
              void action.run(async () => {
                await api.uninstallPackage(item.id, instanceId);
                onChange();
              })
            }
          >
            Uninstall
          </Button>
        </div>
      </div>
      {item.fileIssue === 'unavailable' && (
        <p className="muted">Check the mod file’s permissions and remove any file link before repairing.</p>
      )}
      {editable && versionsOpen && item.source === 'rezics' && (
        <ReleaseVersions
          api={api}
          packageId={item.id}
          instanceId={instanceId}
          gameVersion={gameVersion}
          installedReleaseId={item.releaseId}
          locked={locked || pending}
          onInstall={onChange}
        />
      )}
      {editable && versionsOpen && instanceId && item.source === 'modrinth' && (
        <ModrinthVersions
          api={api}
          instanceId={instanceId}
          project={{ id: item.id.slice('modrinth:'.length), title: item.title }}
          installedReleaseId={item.releaseId}
          locked={locked || pending}
          onInstall={onChange}
        />
      )}
      <Failure error={action.error} />
      {repair.pending && <Pending>Repairing package…</Pending>}
      {item.fileIssue && <Failure error={repair.error} />}
      {instanceId && review && (
        <ModStateReview
          api={api}
          instanceId={instanceId}
          packageId={item.id}
          initial={review}
          locked={locked}
          cancel={closeReview}
          done={() => {
            closeReview();
            onChange();
          }}
        />
      )}
    </li>
  );
}

function ModStateReview({
  api,
  instanceId,
  packageId,
  initial,
  locked,
  cancel,
  done,
}: {
  api: PackagesApi;
  instanceId: string;
  packageId: string;
  initial: MinecraftModStatePreview;
  locked: boolean;
  cancel: () => void;
  done: () => void;
}) {
  const action = useAction();
  const heading = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [review, setReview] = useState(initial);
  useEffect(() => headingRef.current?.focus(), []);

  function refresh() {
    void action.run(async () => {
      const updated = await api.previewModState(instanceId, packageId, review.enabled);
      if (!updated.changes.length) done();
      else setReview(updated);
    });
  }

  return (
    <section className="grid min-w-0 gap-3 rounded-lg border p-3" aria-labelledby={heading}>
      <h4 className="text-sm font-semibold" id={heading} ref={headingRef} tabIndex={-1}>
        {review.enabled ? 'Review enabling required mods' : 'Review disabling dependent mods'}
      </h4>
      <ul className="grid gap-1 text-sm" aria-label="Affected mods">
        {review.changes.map(({ id, title, version }) => (
          <li key={id} className="wrap-anywhere">
            <MetaLine items={[title, version]} />
          </li>
        ))}
      </ul>
      {action.pending && <Pending>Updating mod state…</Pending>}
      <Failure error={action.error} retry={locked ? undefined : refresh} />
      <div className="actions">
        <Button variant="ghost" disabled={action.pending} onClick={cancel}>
          Cancel
        </Button>
        <Button
          disabled={locked || action.pending || Boolean(action.error)}
          onClick={() =>
            void action.run(async () => {
              await api.applyModState(instanceId, packageId, review.enabled, review.revision);
              done();
            })
          }
        >
          {review.enabled ? 'Enable' : 'Disable'} {review.changes.length} {review.changes.length === 1 ? 'mod' : 'mods'}
        </Button>
      </div>
    </section>
  );
}

const sourceLabel = { rezics: 'REZICS', modrinth: 'Modrinth', local: 'Local file' } as const;
const fileIssueLabel = { missing: 'Missing file', damaged: 'Damaged file', unavailable: 'File unavailable' } as const;

function CatalogBrowser({
  api,
  kind,
  instanceId,
  gameVersion,
  installed,
  locked,
  onInstall,
}: {
  api: PackagesApi;
  kind: PackageKind;
  instanceId: string | undefined;
  gameVersion: string | undefined;
  installed: InstalledPackage[];
  locked: boolean;
  onInstall: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogPackage>();
  const paging = usePaging();
  const { cursor } = paging;
  const load = useCallback(() => api.listPackages(kind, query, cursor), [api, kind, query, cursor]);
  const packages = useRemote(load);

  function search(next: string) {
    setQuery(next);
    setSelected(undefined);
    paging.reset();
    if (next === query && !cursor) packages.reload();
  }

  return (
    <>
      <SearchField
        key={kind}
        search={search}
        placeholder={kind === 'overlay-panel' ? 'Search extensions' : 'Search REZICS mods'}
      />
      {packages.pending && <Pending>Loading REZICS catalog…</Pending>}
      <Failure error={packages.error} retry={packages.reload} />
      {!packages.pending && packages.data?.items.length === 0 && (
        <EmptyState density="compact" headingLevel={3} title="No packages found." />
      )}
      {!packages.pending && packages.data && (
        <ul className="rows">
          {packages.data.items.map((item) => (
            <li className="row-item" key={item.id}>
              <div className="row-content">
                <div className="row-text">
                  <strong>{item.title}</strong>
                  <span className="muted">
                    {item.publisher}
                    {item.summary && ` · ${item.summary}`}
                  </span>
                </div>
                <Button
                  variant="outline"
                  aria-expanded={selected?.id === item.id}
                  onClick={() => setSelected((current) => (current?.id === item.id ? undefined : item))}
                >
                  Versions
                </Button>
              </div>
              {selected?.id === item.id && (
                <ReleaseVersions
                  api={api}
                  packageId={item.id}
                  instanceId={instanceId}
                  gameVersion={gameVersion}
                  installedReleaseId={installed.find((pkg) => pkg.id === item.id)?.releaseId}
                  locked={locked}
                  onInstall={onInstall}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager
        cursor={cursor}
        previous={() => {
          setSelected(undefined);
          paging.previous();
        }}
        next={
          !packages.pending && packages.data?.nextCursor
            ? () => {
                const next = packages.data?.nextCursor;
                if (!next) return;
                setSelected(undefined);
                paging.next(next);
              }
            : undefined
        }
      />
    </>
  );
}

function ReleaseVersions({
  api,
  packageId,
  instanceId,
  gameVersion,
  installedReleaseId,
  locked,
  onInstall,
}: {
  api: PackagesApi;
  packageId: string;
  instanceId: string | undefined;
  gameVersion: string | undefined;
  installedReleaseId: string | undefined;
  locked: boolean;
  onInstall: () => void;
}) {
  const paging = usePaging();
  const { cursor } = paging;
  const load = useCallback(() => api.listReleases(packageId, cursor), [api, packageId, cursor]);
  const releases = useRemote(load);
  const [selected, setSelected] = useState<string>();
  const returnFocus = useRef<HTMLButtonElement>(null);
  const items = releases.data?.items ?? [];
  const next = releases.data?.nextCursor;
  function closeReview() {
    setSelected(undefined);
    returnFocus.current?.focus();
  }
  return (
    <div className="version-list">
      {releases.pending && <Pending>Loading versions…</Pending>}
      <Failure error={releases.error} retry={releases.reload} />
      {!releases.pending && releases.data?.items.length === 0 && (
        <EmptyState density="compact" headingLevel={4} title="No releases available." />
      )}
      {!releases.pending && (
        <ul className="rows">
          {items.map((release) => {
            const incompatible =
              release.compatibility.kind === 'minecraft-mod' && release.compatibility.gameVersion !== gameVersion;
            const installed = installedReleaseId === release.id;
            return (
              <li key={release.id} className="row-item">
                <div className="row-content">
                  <div className="row-text">
                    <strong>{release.version}</strong>
                    <span className="muted">{requirements(release)}</span>
                    {release.id !== release.version && <span className="muted">{release.id}</span>}
                  </div>
                  <Button
                    variant="outline"
                    ref={selected === release.id ? returnFocus : undefined}
                    aria-expanded={selected === release.id}
                    aria-disabled={selected === release.id || undefined}
                    disabled={
                      locked || incompatible || installed || (selected !== undefined && selected !== release.id)
                    }
                    onClick={() => setSelected(release.id)}
                  >
                    {installed ? 'Installed' : incompatible ? 'Incompatible' : 'Review install'}
                  </Button>
                </div>
                {selected === release.id && (
                  <CatalogInstallReview
                    api={api}
                    instanceId={instanceId}
                    packageId={packageId}
                    releaseId={release.id}
                    locked={locked}
                    cancel={closeReview}
                    done={() => {
                      closeReview();
                      onInstall();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        cursor={cursor}
        previous={() => {
          closeReview();
          paging.previous();
        }}
        next={
          !releases.pending && next
            ? () => {
                closeReview();
                paging.next(next);
              }
            : undefined
        }
      />
    </div>
  );
}

function requirements(release: CatalogRelease): string {
  const target = release.compatibility;
  return target.kind === 'overlay-panel'
    ? `Launcher ${target.launcherRange}`
    : `Minecraft ${target.gameVersion} · Fabric`;
}

function ModrinthBrowser({
  api,
  instanceId,
  installed,
  locked,
  onInstall,
}: {
  api: PackagesApi;
  instanceId: string;
  installed: InstalledPackage[];
  locked: boolean;
  onInstall: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ModrinthProject>();
  const load = useCallback(() => api.searchMods(instanceId, query), [api, instanceId, query]);
  const mods = useRemote(load);
  return (
    <>
      <SearchField
        placeholder="Search Modrinth"
        search={(next) => {
          setSelected(undefined);
          if (query === next) mods.reload();
          else setQuery(next);
        }}
      />
      {mods.pending && <Pending>Searching Modrinth…</Pending>}
      <Failure error={mods.error} retry={mods.reload} />
      {!mods.pending && mods.data?.length === 0 && (
        <EmptyState density="compact" headingLevel={3} title="No compatible mods found." />
      )}
      {!mods.pending && (
        <ul className="rows">
          {mods.data?.map((mod) => (
            <li key={mod.id} className="row-item">
              <div className="row-content">
                <div className="row-text">
                  <strong>{mod.title}</strong>
                  <span className="muted">{mod.summary}</span>
                </div>
                <Button
                  variant="outline"
                  aria-expanded={selected?.id === mod.id}
                  onClick={() => setSelected((current) => (current?.id === mod.id ? undefined : mod))}
                >
                  Versions
                </Button>
              </div>
              {selected?.id === mod.id && (
                <ModrinthVersions
                  api={api}
                  instanceId={instanceId}
                  project={mod}
                  installedReleaseId={installed.find(({ id }) => id === `modrinth:${mod.id}`)?.releaseId}
                  locked={locked}
                  onInstall={onInstall}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ModrinthVersions({
  api,
  instanceId,
  project: { id: projectId, title: projectTitle },
  installedReleaseId,
  locked,
  onInstall,
}: {
  api: PackagesApi;
  instanceId: string;
  project: Pick<ModrinthProject, 'id' | 'title'>;
  installedReleaseId: string | undefined;
  locked: boolean;
  onInstall: () => void;
}) {
  const load = useCallback(() => api.modVersions(instanceId, projectId), [api, instanceId, projectId]);
  const versions = useRemote(load);
  const [selected, setSelected] = useState<string>();
  const returnFocus = useRef<HTMLButtonElement>(null);
  function closeReview() {
    setSelected(undefined);
    returnFocus.current?.focus();
  }
  return (
    <div className="version-list">
      {versions.pending && <Pending>Loading compatible versions…</Pending>}
      <Failure error={versions.error} retry={versions.reload} />
      {versions.data?.length === 0 && <EmptyState density="compact" headingLevel={4} title="No compatible releases." />}
      <ul className="rows">
        {versions.data?.map((release) => (
          <li key={release.id} className="row-item">
            <div className="row-content">
              <div className="row-text">
                <strong>{release.title}</strong>
                {release.title !== release.version && <span className="muted">{release.version}</span>}
                {release.id === installedReleaseId && <Badge variant="secondary">Installed</Badge>}
              </div>
              <Button
                variant="outline"
                ref={selected === release.id ? returnFocus : undefined}
                aria-expanded={selected === release.id}
                aria-disabled={selected === release.id || undefined}
                disabled={locked || (selected !== undefined && selected !== release.id)}
                onClick={() => setSelected(release.id)}
              >
                {release.id === installedReleaseId ? 'Review current version' : 'Review install'}
              </Button>
            </div>
            {selected === release.id && (
              <ModrinthInstallReview
                api={api}
                instanceId={instanceId}
                versionId={release.id}
                projectTitle={projectTitle}
                locked={locked}
                cancel={closeReview}
                done={() => {
                  closeReview();
                  onInstall();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchField({ placeholder, search }: { placeholder: string; search: (query: string) => void }) {
  const fieldId = useId();
  const [query, setQuery] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    search(query.trim());
  }
  return (
    <form role="search" onSubmit={submit}>
      <FieldGroup className="search">
        <Field>
          <FieldLabel className="sr-only" htmlFor={fieldId}>
            {placeholder}
          </FieldLabel>
          <Input
            id={fieldId}
            name="query"
            placeholder={placeholder}
            value={query}
            maxLength={120}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Button variant="outline" type="submit">
          <Search aria-hidden="true" data-icon="inline-start" /> Search
        </Button>
      </FieldGroup>
    </form>
  );
}
