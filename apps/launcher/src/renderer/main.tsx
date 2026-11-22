import { CSPProvider } from '@base-ui/react/csp-provider';
import {
  isActiveMinecraftPreparation,
  type Instance,
  type LaunchIssue,
  type MinecraftPreparation,
  type MinecraftPreparationMode,
  type Session,
} from '@rezics/launcher-contract';
import { EmptyState } from '@rezics/ui/empty-state';
import { MetaLine } from '@rezics/ui/meta-line';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/shadcn/tabs';
import { Archive, ArrowLeft, ExternalLink, Gamepad2, LibraryBig, Play, Plus, Puzzle, Upload } from 'lucide-react';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import logo from '../../assets/rezics.png';
import {
  bundledFrontendPlugins,
  bundledGamePanels,
  bundledInstanceCreators,
  bundledInstancePresentation,
  bundledLibraryPanels,
} from '../plugins/builtin-plugins';
import { MinecraftPreparationActivity, useMinecraftPreparations } from '../plugins/minecraft-preparation';
import { Failure, Pending, useAction, useRemote } from './actions';
import { ArchivedInstances } from './archived-instances';
import { ConfirmAction } from './confirm-action';
import { ImportGame } from './create-instance';
import { GameIcon, InstalledGames, instanceMetadata } from './installed-games';
import { OverlayControls, OverlayPreferencePanel } from './overlay-controls';
import { Packages } from './packages';
import { Saves, useAutomaticBackup } from './saves';
import { StopGame } from './stop-game';
import './styles.css';

type CreateKind = 'local' | (typeof bundledInstanceCreators)[number]['id'];
type GameNavigation = { panel: string; focusId?: string };

type View =
  | { type: 'library' }
  | { type: 'installed' }
  | { type: 'extensions' }
  | { type: 'archive' }
  | { type: 'game'; instance: Instance; navigation?: GameNavigation }
  | { type: 'create'; kind: CreateKind };

function Launcher() {
  const [view, setView] = useState<View>({ type: 'library' });
  const [installedQuery, setInstalledQuery] = useState('');
  const returnGame = useRef<string | null>(null);
  const lastView = useRef(view);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    if (lastView.current === view) return;
    const previousView = lastView.current.type;
    lastView.current = view;
    if (isLibraryView(previousView) && isLibraryView(view.type)) return;
    if (view.type === 'installed' && returnGame.current) {
      const previous = document.getElementById(`installed-${returnGame.current}`);
      returnGame.current = null;
      if (previous) {
        previous.focus();
        return;
      }
    }
    if (view.type === 'game' && view.navigation?.focusId) return;
    const title = content.current?.querySelector('h1');
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }, [view]);
  const api = window.launcher;
  const instances = useRemote(api.listInstances);
  const reloadInstances = instances.reload;
  useEffect(
    () =>
      api.onInstalledChanged((archivedInstanceIds) => {
        reloadInstances();
        if (archivedInstanceIds?.length) {
          setView((current) =>
            current.type === 'game' && archivedInstanceIds.includes(current.instance.id)
              ? { type: 'installed' }
              : current,
          );
        }
      }),
    [api, reloadInstances],
  );
  const preparations = useMinecraftPreparations(api, instances.reload);
  const activePreparations: MinecraftPreparation[] = [];
  const interruptedPreparations: MinecraftPreparation[] = [];
  let latestFinished: MinecraftPreparation | undefined;
  for (const attempt of preparations.values()) {
    if (isActiveMinecraftPreparation(attempt)) activePreparations.push(attempt);
    else if (attempt.interrupted) interruptedPreparations.push(attempt);
    else if (!latestFinished || latestFinished.updatedAt <= attempt.updatedAt) latestFinished = attempt;
  }
  const [session, setSession] = useState<Session | null>(null);
  const sessionAction = useAction();
  const libraryAction = useAction();
  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = api.onSession((value) => {
      received = true;
      if (active) setSession(value);
    });
    void api.currentSession().then(
      (value) => {
        if (active && !received) setSession(value);
      },
      () => {},
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  function openGame(instance: Instance) {
    setView({ type: 'game', instance });
  }

  function openPreparation(instance: Instance, mode: MinecraftPreparationMode) {
    const navigation =
      mode === 'upgrade'
        ? { panel: 'settings', focusId: 'minecraft-version-change-heading' }
        : { panel: 'overview', focusId: 'minecraft-preparation-heading' };
    setView({ type: 'game', instance, navigation });
  }

  const game =
    view.type === 'game' ? (instances.data?.find(({ id }) => id === view.instance.id) ?? view.instance) : undefined;
  const Creator =
    view.type === 'create' && view.kind !== 'local' ? bundledFrontendPlugins[view.kind].create.Component : undefined;

  function created(instance: Instance) {
    instances.reload();
    openGame(instance);
  }

  function openLibrary() {
    setView({ type: 'library' });
  }
  function openInstalled() {
    setView({ type: 'installed' });
  }
  function openArchive() {
    setView({ type: 'archive' });
  }
  return (
    <div className="desktop">
      <aside className="rail">
        <div className="brand">
          <img src={logo} alt="" width="34" height="34" />
          <div>
            <strong>REZICS</strong>
            <span>Launcher</span>
          </div>
        </div>
        <nav aria-label="Launcher">
          <Button
            variant={view.type !== 'extensions' ? 'secondary' : 'ghost'}
            aria-current={isLibraryView(view.type) ? 'page' : view.type !== 'extensions' ? 'location' : undefined}
            onClick={openLibrary}
          >
            <LibraryBig aria-hidden="true" data-icon="inline-start" /> Library
          </Button>
          <Button
            variant={view.type === 'extensions' ? 'secondary' : 'ghost'}
            aria-current={view.type === 'extensions' ? 'page' : undefined}
            onClick={() => setView({ type: 'extensions' })}
          >
            <Puzzle aria-hidden="true" data-icon="inline-start" /> Extensions
          </Button>
        </nav>
        <div className="rail-activity">
          <MinecraftPreparationActivity
            api={api}
            active={activePreparations}
            interrupted={interruptedPreparations}
            recent={latestFinished}
            instances={instances.data ?? []}
            open={openPreparation}
          />
          {session && (
            <section className="session" aria-label="Active game">
              <Badge variant="secondary">
                <Play aria-hidden="true" data-icon="inline-start" /> Playing
              </Badge>
              <strong>{session.title}</strong>
              <OverlayControls key={session.sessionId} api={api} sessionId={session.sessionId} />
              {session.destinations.map((target) => (
                <Button
                  key={target.id}
                  variant="ghost"
                  disabled={sessionAction.pending}
                  onClick={() => void sessionAction.run(() => api.openDestination(session.sessionId, target.id))}
                >
                  {target.label}
                </Button>
              ))}
              <Failure error={sessionAction.error} />
            </section>
          )}
        </div>
      </aside>
      <main className="content" ref={content}>
        {isLibraryView(view.type) && (
          <header className="section-heading page-heading">
            <h1>Library</h1>
            <div className="actions" role="group" aria-label="Library view">
              <Button
                variant={view.type === 'library' ? 'secondary' : 'ghost'}
                aria-pressed={view.type === 'library'}
                onClick={openLibrary}
              >
                REZICS online
              </Button>
              <Button
                variant={view.type === 'installed' ? 'secondary' : 'ghost'}
                aria-pressed={view.type === 'installed'}
                onClick={openInstalled}
              >
                Installed
              </Button>
            </div>
          </header>
        )}
        {view.type === 'extensions' ? (
          <>
            <h1>Extensions</h1>
            <div className="stack">
              <OverlayPreferencePanel api={api} />
              <Packages api={api} />
            </div>
          </>
        ) : view.type === 'library' ? (
          <div className="stack">
            <Button
              className="self-start"
              disabled={libraryAction.pending}
              onClick={() => void libraryAction.run(api.openRezicsLibrary)}
            >
              Open REZICS Library <ExternalLink aria-hidden="true" data-icon="inline-end" />
            </Button>
            <Failure error={libraryAction.error} />
          </div>
        ) : view.type === 'archive' ? (
          <ArchivedInstances api={api} back={openInstalled} openInstance={created} />
        ) : view.type === 'create' ? (
          <div className="create-workspace">
            {Creator ? (
              <Creator api={api} cancel={openInstalled} done={created} />
            ) : (
              <ImportGame api={api} cancel={openInstalled} done={created} />
            )}
          </div>
        ) : view.type === 'game' && game ? (
          <Game
            key={game.id}
            instance={game}
            back={() => {
              returnGame.current = game.id;
              openInstalled();
            }}
            session={session}
            refresh={instances.reload}
            openInstance={created}
            openArchive={openArchive}
            preparation={preparations.get(game.id)}
            preparingMinecraft={activePreparations.length > 0}
            initialNavigation={view.navigation}
          />
        ) : (
          <>
            <div className="actions mb-4">
              <Button size="lg" variant="ghost" onClick={openArchive}>
                <Archive aria-hidden="true" data-icon="inline-start" /> Archived instances
              </Button>
              <Button size="lg" onClick={() => setView({ type: 'create', kind: 'local' })}>
                <Upload aria-hidden="true" data-icon="inline-start" /> Import game
              </Button>
              {bundledInstanceCreators.map(({ id, label }) => (
                <Button key={id} size="lg" variant="outline" onClick={() => setView({ type: 'create', kind: id })}>
                  <Plus aria-hidden="true" data-icon="inline-start" /> {label}
                </Button>
              ))}
            </div>
            {instances.pending && !instances.data && <Pending>Loading your games…</Pending>}
            <Failure error={instances.error} retry={instances.reload} />
            {instances.data?.length === 0 && (
              <EmptyState
                className="border border-dashed"
                icon={<Gamepad2 />}
                title="No games installed here"
                description="Import an installed game or create a Minecraft instance to get started."
              />
            )}
            <div className="installed-options">
              {bundledLibraryPanels.map(({ key, Component }) => (
                <Component key={key} api={api} />
              ))}
            </div>
            {instances.data && instances.data.length > 0 && (
              <InstalledGames
                instances={instances.data}
                playing={session?.instanceId}
                query={installedQuery}
                setQuery={setInstalledQuery}
                open={openGame}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function isLibraryView(view: View['type']) {
  return view === 'library' || view === 'installed';
}

function Game({
  instance,
  back,
  session,
  refresh,
  openInstance,
  openArchive,
  preparation,
  preparingMinecraft,
  initialNavigation,
}: {
  instance: Instance;
  back: () => void;
  session: Session | null;
  refresh: () => void;
  openInstance: (instance: Instance) => void;
  openArchive: () => void;
  preparation: MinecraftPreparation | undefined;
  preparingMinecraft: boolean;
  initialNavigation: GameNavigation | undefined;
}) {
  const api = window.launcher;
  const action = useAction();
  const subjectAction = useAction();
  const automaticBackup = useAutomaticBackup(api, instance.id);
  const [{ revision: launchRevision, finishedAt: launchFinishedAt }, setLaunchAttempt] = useState({
    revision: 0,
    finishedAt: 0,
  });
  const [resolvedLaunchRevision, setResolvedLaunchRevision] = useState(0);
  const launchError = resolvedLaunchRevision < launchRevision ? action.error : undefined;
  const activeSession = session?.instanceId === instance.id ? session : null;
  const canLaunch = bundledInstancePresentation(instance)?.canLaunch(instance) ?? true;
  const panels = bundledGamePanels(instance);
  const overview = panels.find(({ placement }) => placement === 'overview');
  const [navigation, setNavigation] = useState(initialNavigation);
  useEffect(() => {
    if (initialNavigation) setNavigation(initialNavigation);
  }, [initialNavigation]);
  useEffect(() => {
    if (navigation?.focusId) document.getElementById(navigation.focusId)?.focus();
  }, [navigation]);

  const selectPanel = (panel: string, focusId: string) => setNavigation({ panel, focusId });
  const resolveLaunchIssue = useCallback(
    async (kind: LaunchIssue['kind']) => {
      if (!launchError) return;
      const report = await api.readLaunchReport(instance.id).catch(() => null);
      if (report?.issue?.kind === kind && report.issue.summary.startsWith(launchError)) {
        setResolvedLaunchRevision((current) => Math.max(current, launchRevision));
      }
    },
    [api, instance.id, launchError, launchRevision],
  );
  useEffect(() => {
    if (preparation?.mode === 'repair' && preparation.state === 'ready' && preparation.updatedAt > launchFinishedAt) {
      void resolveLaunchIssue('installation');
    }
  }, [launchFinishedAt, preparation, resolveLaunchIssue]);
  const panelProps = {
    api,
    instance,
    running: activeSession !== null,
    sessionActive: session !== null,
    resolveLaunchIssue,
    preparation,
    refresh,
    openInstance,
    openArchive,
    selectPanel,
  };
  const sections = [
    ...(overview ? [{ id: 'overview', label: overview.label, content: <overview.Component {...panelProps} /> }] : []),
    ...panels
      .filter(({ placement }) => placement === 'game')
      .map(({ id, label, Component }) => ({
        id,
        label,
        content: <Component {...panelProps} />,
      })),
    {
      id: 'saves',
      label: 'Saves',
      content: (
        <Saves
          key={activeSession?.sessionId ?? 'closed'}
          instanceId={instance.id}
          running={activeSession !== null}
          minecraft={instance.kind === 'minecraft'}
          automatic={automaticBackup}
        />
      ),
    },
    ...panels
      .filter(({ placement }) => placement === 'utility')
      .map(({ id, label, Component }) => ({
        id,
        label,
        content: <Component {...panelProps} />,
      })),
  ];
  const selectedPanel = sections.find(({ id }) => id === navigation?.panel)?.id ?? sections[0]?.id ?? 'saves';
  const backingUp = automaticBackup.status?.state === 'running';

  return (
    <div className="stack">
      <div>
        <Button variant="ghost" onClick={back}>
          <ArrowLeft aria-hidden="true" data-icon="inline-start" /> Installed
        </Button>
      </div>
      <header className="game-heading">
        <span className="game-mark" data-kind={instance.kind}>
          <GameIcon instance={instance} />
        </span>
        <div className="game-title">
          <h1>{instance.name}</h1>
          <div className="game-subtitle">
            <MetaLine className="muted" items={instanceMetadata(instance)} />
            {instance.subjectId && (
              <Button
                variant="link"
                size="sm"
                disabled={subjectAction.pending}
                onClick={() => void subjectAction.run(() => api.openGameInfo(instance.id))}
              >
                View on REZICS <ExternalLink aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
        <div className="actions">
          {instance.kind !== 'minecraft' && (
            <ConfirmAction
              label="Archive instance"
              title={`Archive ${instance.name}?`}
              description="This removes the instance from Installed and keeps its REZICS link and backup history. The game and its saves stay in their current folders."
              disabled={action.pending || activeSession !== null || backingUp}
              confirm={async () => {
                await api.setLocalGameArchived(instance.id, true);
                refresh();
                openArchive();
              }}
            />
          )}
          {(canLaunch || activeSession || isActiveMinecraftPreparation(preparation)) && (
            <Button
              size="lg"
              disabled={
                action.pending || session !== null || backingUp || (instance.kind === 'minecraft' && preparingMinecraft)
              }
              onClick={() =>
                void action.run(async () => {
                  try {
                    await api.launch(instance.id);
                  } finally {
                    const finishedAt = Date.now();
                    setLaunchAttempt(({ revision }) => ({ revision: revision + 1, finishedAt }));
                  }
                })
              }
            >
              <Play aria-hidden="true" data-icon="inline-start" /> {activeSession ? 'Playing' : 'Play'}
            </Button>
          )}
          {activeSession && <StopGame sessionId={activeSession.sessionId} />}
        </div>
      </header>
      <Failure error={subjectAction.error} />
      {action.pending && <Pending>Preparing game…</Pending>}
      {selectedPanel !== 'saves' && backingUp && <Pending>Backing up saves…</Pending>}
      {selectedPanel !== 'saves' && automaticBackup.status?.state === 'failed' && (
        <div className="grid gap-2">
          <Failure error="Automatic backup failed." />
          <Button
            className="justify-self-start"
            size="sm"
            variant="outline"
            onClick={() => selectPanel('saves', 'saves-heading')}
          >
            Open save history
          </Button>
        </div>
      )}
      <Failure error={launchError} />
      {launchError && navigation?.panel !== 'logs' && (
        <div>
          <Button variant="outline" size="sm" onClick={() => selectPanel('logs', 'launch-log-heading')}>
            View launch log
          </Button>
        </div>
      )}
      <Tabs value={selectedPanel} onValueChange={(panel: string) => setNavigation({ panel })}>
        <TabsList aria-label="Game sections" variant="line" className="game-sections">
          {sections.map(({ id, label }) => (
            <TabsTrigger key={id} id={`game-panel-${id}`} value={id}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {sections.map(({ id, content }) => (
          <TabsContent key={id} className={id === 'overview' ? 'stack' : undefined} value={id}>
            {content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Launcher root element is missing.');
createRoot(root).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      {window.launcher ? <Launcher /> : <p role="alert">Open this page in the REZICS Launcher desktop app.</p>}
    </CSPProvider>
  </StrictMode>,
);
