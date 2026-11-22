import type { SubjectRead } from '@rezics/client';
import type { FakeRoute } from '../fake-modules';
import { albumFixture, albumId } from './catalogue-album-profile';
import { gameId, gameProfileFixture } from './catalogue-game-profile';

let current: SubjectRead | undefined;

function select(subject: SubjectRead) {
  current = subject;
  return () => {
    if (current === subject) current = undefined;
  };
}

export function prepareAlbumCorrection() {
  return select(albumFixture().publicRead);
}

export function prepareGameCorrection() {
  return select(gameProfileFixture('ready', 'en', true).publicRead);
}

// A correction visit owns its example. Other fixture families can reuse these illustrative IDs.
export const routes: FakeRoute[] = [albumId, gameId].map((id) => ({
  method: 'GET',
  path: `/v1/subjects/${id}`,
  story({ request }) {
    if (current?.subject.id !== id) return;
    const context = new URL(request.url).searchParams.get('context');
    if (context && context !== current.subject.context) return { status: 404 };
    return { status: 200, ...current };
  },
}));
