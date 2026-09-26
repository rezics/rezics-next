import type { CargoLiveScenario } from './cargo-live-scenarios.ts';

// A small registry for Cargo feature forms that the live snapshot does not
// exercise: weak `dep?/feature`, `dep:` without an implicit feature, renamed
// `package`, proc-macro host decoupling, triple and nested cfg predicates and
// build-dependency platforms evaluated for the host. Native Cargo 1.98.1 results
// for the same records are recorded by `yarn package:cargo-oracle`.

const CHECKSUM = '0'.repeat(64);
type Dep = { name: string; req: string; features?: string[]; optional?: boolean;
  default_features?: boolean; target?: string | null; kind?: 'normal' | 'build' | 'dev';
  package?: string | null };

function line(name: string, vers: string, deps: Dep[], features: Record<string, string[]> = {},
  features2: Record<string, string[]> | null = null): string {
  return JSON.stringify({ name, vers, deps: deps.map(dep => ({ features: [], optional: false,
    default_features: true, target: null, kind: 'normal', registry: null, package: null, ...dep })),
  cksum: CHECKSUM, features, yanked: false, ...features2 ? { features2, v: 2 } : {} });
}

export const CARGO_SYNTHETIC_PROC_MACROS = ['gamma@1.0.0'];

export function cargoSyntheticIndex(): Map<string, Uint8Array> {
  const files: Record<string, string[]> = {
    alpha: [line('alpha', '1.0.0', [
      { name: 'opt', req: '^1', optional: true },
      { name: 'opt2', req: '^1', optional: true },
      { name: 'beta_alias', req: '^1', package: 'beta', default_features: false },
    ], { default: ['std'], plain: [] }, { std: ['opt?/std', 'opt2?/std', 'beta_alias/extra'],
      'with-opt': ['dep:opt'] })],
    opt: [line('opt', '1.0.0', [], { std: [] })],
    opt2: [line('opt2', '1.0.0', [], { std: [] })],
    beta: [line('beta', '1.0.0', [], { default: ['base'], base: [], extra: [] })],
    gamma: [line('gamma', '1.0.0', [{ name: 'delta', req: '^1' }])],
    delta: [line('delta', '1.0.0', [], { default: ['x'], x: [], y: [] })],
    plat: [line('plat', '1.0.0', [
      { name: 'winonly', req: '^1', target: 'x86_64-pc-windows-msvc' },
      { name: 'unixbuild', req: '^1', kind: 'build', target: 'cfg(unix)' },
      { name: 'armonly', req: '^1', target: 'cfg(all(target_arch = "aarch64", not(windows)))' },
      { name: 'delta', req: '^1', default_features: false, kind: 'build', features: ['y'] },
    ])],
    winonly: [line('winonly', '1.0.0', [])],
    unixbuild: [line('unixbuild', '1.0.0', [])],
    armonly: [line('armonly', '1.0.0', [])],
  };
  return new Map(Object.entries(files).map(([name, lines]) =>
    [name, new TextEncoder().encode(`${lines.join('\n')}\n`)]));
}

const manifest = (resolver: string) => `[package]
name = "rezics-synthetic-features"
version = "0.1.0"
edition = "2021"
resolver = "${resolver}"

[dependencies]
alpha = { version = "1", default-features = false }
gamma = "1"
delta = { version = "1", default-features = false, features = ["y"] }
plat = "1"

[features]
default = ["alpha-std"]
alpha-std = ["alpha/std"]
opt = ["alpha/with-opt"]
`;

const linux = { label: 'linux', target: 'x86_64-unknown-linux-gnu' as const, features: [],
  defaultFeatures: true, includeDev: false };
export const CARGO_SYNTHETIC_SCENARIOS: CargoLiveScenario[] = [
  { id: 'synthetic-resolver2', cases: ['PKG01'], expected: 'solved', manifest: manifest('2'),
    variants: [linux, { ...linux, label: 'linux-opt', features: ['opt'] },
      { ...linux, label: 'linux-no-default', defaultFeatures: false },
      { ...linux, label: 'windows', target: 'x86_64-pc-windows-msvc' },
      { ...linux, label: 'macos', target: 'aarch64-apple-darwin' }] },
  { id: 'synthetic-resolver1', cases: ['PKG01'], expected: 'solved', manifest: manifest('1'),
    variants: [linux, { ...linux, label: 'linux-opt', features: ['opt'] },
      { ...linux, label: 'windows', target: 'x86_64-pc-windows-msvc' }] },
];
