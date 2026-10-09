// Runs the pinned Knip analyzer. It prints a proxy warning whenever proxy
// variables exist, although analysis makes no network requests.
//
// Script files are project files, not a blanket entry. Entries come from real
// launchers and declared directory scans. Export findings stay off for scripts:
// those files used to all be entries, so the new signal is an unreached file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  discoveryProblems,
  scriptDiscoveries,
  scriptEntryFiles,
  scriptProjectPattern,
} from './script-entries.ts';

const root = resolve(import.meta.dir, '../..');
const problems = discoveryProblems(root);
if (problems.length) throw new Error(problems.join('\n'));

type Workspace = {
  entry?: string[];
  project?: string[];
};
type KnipConfig = {
  ignoreIssues?: Record<string, string[]>;
  workspaces: Record<string, Workspace>;
};

const config = Bun.JSON5.parse(readFileSync(join(root, 'knip.jsonc'), 'utf8')) as KnipConfig;
const workspace = config.workspaces['.'];
if (!workspace?.entry || !workspace.project) throw new Error('Root Knip workspace is missing');
if (workspace.entry.includes(scriptProjectPattern)) {
  throw new Error('knip.jsonc must not list every script as an entry');
}

const entry = new Set(workspace.entry);
for (const discovery of scriptDiscoveries) entry.add(discovery.pattern);
const scanned = scriptDiscoveries.map((discovery) => new Bun.Glob(discovery.pattern));
for (const file of scriptEntryFiles(root)) {
  if (!scanned.some((pattern) => pattern.match(file))) entry.add(file);
}
workspace.entry = [...entry];
if (!workspace.project.includes(scriptProjectPattern)) workspace.project.push(scriptProjectPattern);
// Root-workspace ignoreIssues live at the top level; Knip does not apply them
// from workspaces["."]. Script helpers used to be entries, so export findings
// stay off and an unreached file is the new report.
config.ignoreIssues = {
  ...config.ignoreIssues,
  [scriptProjectPattern]: [
    'exports',
    'types',
    'nsExports',
    'nsTypes',
    'duplicates',
    'enumMembers',
    'namespaceMembers',
  ],
};

const generated = join(root, '.temp/knip.script-entries.json');
mkdirSync(join(root, '.temp'), { recursive: true });
writeFileSync(generated, JSON.stringify(config));

const args = process.argv.slice(2);
const configArgs = args.some((arg) => arg === '--config' || arg.startsWith('--config='))
  ? []
  : ['--config', generated];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(?:https?|all|no)_proxy$/i.test(key)),
);
const child = Bun.spawn(['node_modules/.bin/knip', '--no-progress', ...configArgs, ...args], {
  cwd: root,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
