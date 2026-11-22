import { expect, test } from 'bun:test';
import { albumId } from '../src/kernel/fake/catalogue-album-profile';
import { gameId } from '../src/kernel/fake/catalogue-game-profile';
import { prepareAlbumCorrection, prepareGameCorrection, routes } from '../src/kernel/fake/catalogue-profile-review';

function read(id: string, context = '') {
  const path = `/v1/subjects/${id}`;
  const request = new Request(`https://kernel.test${path}${context}`);
  return routes
    .find((route) => route.method === 'GET' && route.path === path)
    ?.story?.({
      request,
      match: null,
      recordings: {},
    });
}

test('routed catalogue examples answer only their own public reads for the active visit', async () => {
  expect(await read(albumId)).toBeUndefined();
  const closeAlbum = prepareAlbumCorrection();
  try {
    expect(await read(albumId)).toMatchObject({ status: 200, subject: { id: albumId, type: 'schema:MusicAlbum' } });
    expect(await read(gameId)).toBeUndefined();
    expect(await read(albumId, '?context=another')).toEqual({ status: 404 });
    const closeGame = prepareGameCorrection();
    try {
      closeAlbum();
      expect(await read(albumId)).toBeUndefined();
      expect(await read(gameId)).toMatchObject({
        status: 200,
        subject: { id: gameId, labels: { ja: '灯りのゲーム' } },
      });
    } finally {
      closeGame();
    }
    expect(await read(gameId)).toBeUndefined();
  } finally {
    closeAlbum();
  }
});
