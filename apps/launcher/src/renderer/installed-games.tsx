import type { Instance } from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { BookOpen, Box, Search } from 'lucide-react';
import { useRef } from 'react';
import { bundledInstancePresentation } from '../plugins/builtin-plugins';

export function GameIcon({ instance }: { instance: Instance }) {
  const Icon = bundledInstancePresentation(instance)?.Icon ?? (instance.kind === 'visual-novel' ? BookOpen : Box);
  return <Icon aria-hidden="true" />;
}

export function instanceMetadata(instance: Instance) {
  return (
    bundledInstancePresentation(instance)?.metadata(instance) ?? [
      instance.kind === 'visual-novel' ? 'Visual novel' : 'Local game',
    ]
  );
}

export function InstalledGames({
  instances,
  playing,
  query,
  setQuery,
  open,
}: {
  instances: Instance[];
  playing: string | undefined;
  query: string;
  setQuery: (query: string) => void;
  open: (instance: Instance) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const games = instances.filter((instance) =>
    [instance.name, ...instanceMetadata(instance)].filter(Boolean).join(' ').toLowerCase().includes(needle),
  );
  return (
    <div className="installed-games">
      <div className="installed-tools">
        <label className="installed-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search installed games</span>
          <Input
            ref={search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, game type or version"
          />
        </label>
        <span className="muted" role="status">
          {needle ? `${games.length} of ${instances.length}` : instances.length}{' '}
          {instances.length === 1 ? 'game' : 'games'}
        </span>
      </div>
      {games.length ? (
        <ul className="library-grid" aria-label="Installed games">
          {games.map((instance) => (
            <li key={instance.id}>
              <button id={`installed-${instance.id}`} className="game-card" onClick={() => open(instance)}>
                <span className="game-symbol" data-kind={instance.kind}>
                  <GameIcon instance={instance} />
                </span>
                <span className="game-description">
                  <strong>{instance.name}</strong>
                  <MetaLine className="muted" items={instanceMetadata(instance)} />
                  {playing === instance.id && <span className="playing-mark">Playing</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="no-game-match">
          <p>No installed games match “{query}”.</p>
          <Button
            variant="outline"
            onClick={() => {
              setQuery('');
              search.current?.focus();
            }}
          >
            Clear search
          </Button>
        </div>
      )}
    </div>
  );
}
