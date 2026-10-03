import { Acquisition } from './network.ts';
import { datasetRoot } from './store.ts';
import { fetchMusicBrainz } from './musicbrainz.ts';
import { fetchVndb, VNDB_DUMP_URL } from './vndb.ts';
import { fetchBangumi } from './bangumi.ts';
import {
  freezeSnapshot,
  latestSnapshot,
  readSnapshot,
  verifySnapshot,
  type ImageMode,
} from './snapshot.ts';
import { importDataset } from './import.ts';
import { preflightDatasetImport } from './auth.ts';
import { testDataset } from './conformance.ts';
import type { Provider } from './types.ts';

const providers: Provider[] = ['vndb', 'bangumi', 'musicbrainz'];
export interface DatasetOptions {
  command: 'fetch' | 'verify' | 'import' | 'test';
  source?: Provider;
  dataset?: string;
  images: ImageMode;
  refresh: boolean;
  downloadOnly: boolean;
  preflight: boolean;
  maxRecords?: number;
  sourceOnly: boolean;
  locale: string;
}
export function parseDatasetOptions(args: string[]): DatasetOptions {
  const [command, ...rest] = args;
  if (!['fetch', 'verify', 'import', 'test'].includes(command ?? ''))
    throw new Error(
      'Use task dataset:fetch|verify|import|test -- [--source vndb|bangumi|musicbrainz|all] [--dataset <id>]',
    );
  const options: DatasetOptions = {
    command: command as DatasetOptions['command'],
    images: 'covers',
    refresh: false,
    downloadOnly: false,
    preflight: false,
    sourceOnly: false,
    locale: 'zh-Hant',
  };
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate dataset option: ${flag}`);
    seen.add(flag);
    if (['--refresh', '--download-only', '--preflight', '--source-only'].includes(flag)) {
      if (flag === '--refresh') options.refresh = true;
      if (flag === '--download-only') options.downloadOnly = true;
      if (flag === '--preflight') options.preflight = true;
      if (flag === '--source-only') options.sourceOnly = true;
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing dataset option value: ${flag}`);
    if (flag === '--source' && (value === 'all' || providers.includes(value as Provider)))
      options.source = value === 'all' ? undefined : (value as Provider);
    else if (flag === '--dataset' && /^dataset-[a-f0-9]{20}$/.test(value)) options.dataset = value;
    else if (flag === '--images' && ['none', 'covers', 'all'].includes(value))
      options.images = value as ImageMode;
    else if (flag === '--locale' && /^(en|zh-Hans|zh-Hant|ja|ko|fr|de|es)$/.test(value))
      options.locale = value;
    else if (flag === '--max-records' && /^[1-9][0-9]{0,5}$/.test(value))
      options.maxRecords = Number(value);
    else throw new Error(`Invalid dataset option: ${flag} ${value}`);
  }
  if (
    (options.command !== 'fetch' &&
      (options.refresh || options.downloadOnly || seen.has('--images'))) ||
    (options.command !== 'import' &&
      (options.preflight || options.maxRecords || options.sourceOnly || seen.has('--locale'))) ||
    (options.command === 'fetch' && options.dataset)
  )
    throw new Error('Dataset option does not apply to this command');
  return options;
}

export async function runDatasets(options: DatasetOptions): Promise<void> {
  const root = datasetRoot();
  console.log(`Local dataset store: ${root}`);
  if (options.preflight) {
    console.log(await preflightDatasetImport());
    return;
  }
  if (options.command === 'fetch') {
    // Dump selectors walk >1GB archives. Do not stack their decompression heaps.
    for (const provider of options.source ? [options.source] : providers) {
      const acquisition = new Acquisition(root, options.refresh);
      console.log(`Acquiring ${provider}`);
      if (options.downloadOnly) {
        if (provider === 'vndb')
          await acquisition.capture(VNDB_DUMP_URL, { limit: 512 * 1024 * 1024 });
        else if (provider === 'bangumi') {
          const latest = (await acquisition.json(
            'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json',
          )) as { browser_download_url: string; digest: string };
          await acquisition.capture(latest.browser_download_url, {
            limit: 1024 * 1024 * 1024,
            expectedDigest: latest.digest.replace(/^sha256:/, ''),
          });
        } else throw new Error('--download-only applies to VNDB and Bangumi dumps');
        continue;
      }
      const source =
        provider === 'vndb'
          ? await fetchVndb(acquisition)
          : provider === 'bangumi'
            ? await fetchBangumi(acquisition)
            : await fetchMusicBrainz(acquisition);
      const snapshot = await freezeSnapshot(acquisition, [source], options.images);
      console.log(
        `Snapshot ${snapshot.id}: ${source.records.length} records; ${source.edges.length} edges; ${snapshot.images.length} elected images`,
      );
    }
    return;
  }
  const snapshots = options.dataset
    ? [readSnapshot(root, options.dataset)]
    : options.source
      ? [latestSnapshot(root, options.source)]
      : providers.map((provider) => latestSnapshot(root, provider));
  for (const snapshot of snapshots) {
    if (options.source && !snapshot.sources.some((source) => source.provider === options.source))
      throw new Error('Dataset snapshot does not contain the requested source');
    if (options.command === 'verify') console.log(snapshot.id, verifySnapshot(root, snapshot));
    else if (options.command === 'test') console.log(snapshot.id, testDataset(root, snapshot));
    else
      console.log(
        await importDataset(root, snapshot, {
          locale: options.locale,
          native: !options.sourceOnly,
          relationships: !options.sourceOnly,
          maxRecords: options.maxRecords,
          progress: (message) => console.log(message),
        }),
      );
  }
}

if (import.meta.main) {
  try {
    await runDatasets(parseDatasetOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
