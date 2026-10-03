import { verifySnapshot } from './snapshot.ts';
import type { DatasetSnapshot, DatasetSource } from './types.ts';

function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Dataset conformance: ${message}`);
}
function kind(source: DatasetSource, value: string): number {
  return source.records.filter((record) => record.kind === value).length;
}

/** Explicit real-data acceptance, never discovered by the default unit suite.
 * Acquisition tests use separate small independent fixtures. This suite checks
 * the actual frozen source corpus offline, including all captured bytes. */
export function testDataset(root: string, snapshot: DatasetSnapshot): Record<string, number> {
  const verified = verifySnapshot(root, snapshot);
  let cases = 0;
  for (const source of snapshot.sources) {
    if (source.provider === 'vndb') {
      require(source.roots.includes('vndb:vn:v11'), 'Fate/stay night root absent');
      cases++;
      require(Number(source.scope.familyCount) >= 20, 'Fate family lost elected members');
      cases++;
      for (const expected of ['release', 'character', 'staff', 'tag', 'trait']) {
        require(kind(source, expected) >= 20, `Fate ${expected} corpus is too small`);
        cases++;
      }
      require(source.edges.some(
        (edge) => edge.kind === 'voice-actor',
      ), 'voice actor relations absent');
      cases++;
      require(source.edges.some(
        (edge) => edge.kind === 'tag-vote' && edge.data.spoiler !== undefined,
      ), 'tag qualifiers lost');
      cases++;
    } else if (source.provider === 'bangumi') {
      require(source.records.some(
        (row) => row.kind === 'subject' && /ONE PIECE|ワンピース|海[贼賊]王/i.test(row.title),
      ), 'One Piece absent');
      cases++;
      require(source.records.some(
        (row) => row.kind === 'subject' && /Re[:：]|从零|從零/i.test(row.title),
      ), 'Re:Zero absent');
      cases++;
      require(source.records.some(
        (row) => row.kind === 'subject' && /禁書目録|禁书目录|禁書目錄/i.test(row.title),
      ), 'Toaru absent');
      cases++;
      require(kind(source, 'episode') >= 1_000, 'long-form episode corpus incomplete');
      cases++;
      for (const expected of ['person', 'character', 'tag']) {
        require(kind(source, expected) >= 50, `Bangumi ${expected} corpus is too small`);
        cases++;
      }
      require(source.records
        .filter((row) => row.kind === 'subject')
        .some((row) => typeof row.data.infobox === 'string'), 'raw infobox lost');
      cases++;
    } else {
      require(source.roots.length === 3, 'three complex MusicBrainz albums required');
      cases++;
      require(kind(source, 'release') >= 100, 'regional/reissue release corpus missing');
      cases++;
      require(kind(source, 'recording') >= 50 &&
        kind(source, 'work') >= 30, 'recording/composition distinction lost');
      cases++;
      require(source.edges.some(
        (edge) => edge.kind === 'track' && edge.data.medium,
      ), 'disc/track structure lost');
      cases++;
      require(source.records.some((row) =>
        Array.isArray(row.data['artist-credit']),
      ), 'artist credits missing');
      cases++;
    }
  }
  return { ...verified, cases };
}
