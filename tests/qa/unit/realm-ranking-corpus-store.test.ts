import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixtureRoot, root } from '../../../scripts/fixture/stack.ts';
import { corpusBackupSourceDirectory } from '../../../scripts/load/catalogue-backup.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import {
  REALM_RANKING_CORPUS_VERSION,
  REALM_RANKING_FILLERS,
  REALM_RANKING_SCALES,
  readRealmRankingCorpus,
  realmRankingCorpusDirectory,
  realmRankingCorpusKey,
  realmRankingCorpusRoot,
  type RealmRankingCorpusManifest,
} from '../../../services/main/tests/realm-ranking-corpus.ts';

test('ranking backups resolve through the fixture store for every checkout and its override', () => {
  expect(realmRankingCorpusRoot()).toBe(join(dirname(fixtureRoot), 'work-profiles',
    'realm-ranking-corpus', realmRankingCorpusKey()));
  const fixtures = join(root, '.temp/ranking-store/shared/fixture');
  const corpus = join(realmRankingCorpusDirectory(fixtures), 'compatible-key', '100');
  for (const checkout of [root, join(root, '.temp/ranking-store/worktree')]) {
    expect(corpusBackupSourceDirectory(corpus, checkout, fixtures)).toBe(corpus);
  }
  const overridden = join(root, '.temp/ranking-store/private/fixture');
  expect(realmRankingCorpusDirectory(overridden))
    .toBe(join(root, '.temp/ranking-store/private/work-profiles/realm-ranking-corpus'));
});

test('shared ranking manifests require compatible storage and every retained cut', () => {
  const directory = mkdtempSync(join(root, '.temp/ranking-corpus-store-'));
  const reply = { reply: 'reply', revision: 'revision', placement: 'placement', digest: 'digest', review: 'review' };
  const manifest: RealmRankingCorpusManifest = {
    format: 'realm-ranking-corpus-v1', version: REALM_RANKING_CORPUS_VERSION,
    compatibility: loadCompatibility(root), preparationMs: 100, fillers: REALM_RANKING_FILLERS,
    scales: [...REALM_RANKING_SCALES],
    identity: { dataEpoch: 'epoch', routingEpoch: 'routing', realm: 'realm', author: 'author',
      reader: 'reader', work: 'work', draftRevision: 'draft', opening: reply, second: reply,
      deepChain: Array.from({ length: 40 }, () => reply), winner: { reply: 'reply', placement: 'placement' },
      followups: { realm: 'realm', work: 'work', draftRevision: 'draft', clean: reply,
        chainRoot: reply, chain: Array.from({ length: 34 }, () => reply),
        wideRoot: reply, wide: Array.from({ length: 193 }, () => reply) } },
  };
  const save = (value = manifest) => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
  try {
    save();
    expect(readRealmRankingCorpus(directory)).toBeUndefined();
    for (const size of REALM_RANKING_SCALES) {
      mkdirSync(join(directory, String(size), 'objects'), { recursive: true });
      writeFileSync(join(directory, String(size), 'backup.json'), '{}');
      writeFileSync(join(directory, String(size), 'compose.env'), '');
    }
    expect(readRealmRankingCorpus(directory)).toEqual(manifest);
    save({ ...manifest, compatibility: { ...manifest.compatibility, files: {} } });
    expect(readRealmRankingCorpus(directory)).toBeUndefined();
    save();
    rmSync(join(directory, '400', 'objects'), { recursive: true });
    expect(readRealmRankingCorpus(directory)).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
