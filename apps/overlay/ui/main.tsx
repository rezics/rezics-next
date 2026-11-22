import {
  defaultOverlayShortcut,
  overlayShortcutLabels,
  type DestinationId,
  type OverlayShortcut,
  type Session,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Kbd } from '@rezics/ui/shadcn/kbd';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import './overlay.css';

type OverlaySession = Pick<Session, 'sessionId' | 'title' | 'startedAt' | 'destinations' | 'panels'>;
type OverlayState = {
  mode: 'hidden' | 'hud' | 'interactive';
  session: OverlaySession | null;
  shortcut?: OverlayShortcut;
  interactionId: number | null;
};
type Command =
  | { type: 'ready' }
  | ({ sessionId: string; interactionId: number } & (
      | { type: 'hide' | 'hud' }
      | { type: 'open-destination'; destination: DestinationId }
    ));

declare global {
  interface Window {
    ipc?: { postMessage(value: string): void };
  }
}

let overlay: OverlayState = { mode: 'hidden', session: null, interactionId: null };

function post(command: Command) {
  window.ipc?.postMessage(JSON.stringify(command));
}

function subscribe(callback: () => void) {
  const receive = (event: Event) => {
    overlay = (event as CustomEvent<OverlayState>).detail;
    callback();
  };
  window.addEventListener('rezics-overlay-state', receive);
  post({ type: 'ready' });
  return () => window.removeEventListener('rezics-overlay-state', receive);
}

function getState() {
  return overlay;
}

function Overlay() {
  const { mode, session, interactionId, shortcut = defaultOverlayShortcut } = useSyncExternalStore(subscribe, getState);
  const heading = useRef<HTMLHeadingElement>(null);
  const interactive = mode === 'interactive';
  const sessionId = session?.sessionId;

  useEffect(() => {
    if (!interactive || !sessionId || interactionId == null) return;
    heading.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      post({ type: 'hide', sessionId, interactionId });
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [interactive, sessionId, interactionId]);

  if (!session || mode === 'hidden') return null;

  if (!interactive) {
    return (
      <aside className="hud">
        <span>{session.title}</span>
        <Kbd>{overlayShortcutLabels[shortcut]}</Kbd>
      </aside>
    );
  }

  if (interactionId == null) return null;
  const panel = { sessionId: session.sessionId, interactionId };
  const open = (destination: DestinationId) => post({ type: 'open-destination', ...panel, destination });

  return (
    <main className="panel" aria-labelledby="game-title">
      <header className="panel-header">
        <h1 id="game-title" ref={heading} tabIndex={-1}>
          {session.title}
        </h1>
        <Button variant="outline" size="lg" onClick={() => post({ type: 'hide', ...panel })}>
          Return to game <Kbd>Esc</Kbd>
        </Button>
      </header>

      {(session.destinations.length > 0 || !!session.panels?.length) && (
        <div className="panel-scroll" role="region" aria-label="Overlay content" tabIndex={0}>
          {session.destinations.length > 0 && (
            <nav aria-label="REZICS" className="game-links">
              {session.destinations.map((link) => (
                <Button key={link.id} variant="secondary" size="lg" onClick={() => open(link.id)}>
                  {link.label}
                </Button>
              ))}
            </nav>
          )}

          {session.panels?.map((panel) => {
            const link = session.destinations.find(({ id }) => id === panel.destination);
            return (
              <section key={panel.id} className="extension">
                <h2>{panel.title}</h2>
                <p>{panel.text}</p>
                {link && (
                  <Button variant="secondary" size="lg" onClick={() => open(link.id)}>
                    {link.label}
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      )}
      <footer className="panel-footer">
        <Button variant="outline" size="lg" onClick={() => post({ type: 'hud', ...panel })}>
          Pin compact view
        </Button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
