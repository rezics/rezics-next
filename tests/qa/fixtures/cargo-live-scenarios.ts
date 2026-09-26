import type { CargoTriple } from '../../../services/main/src/modules/package/cargo-cfg.ts';
import type { CargoSolveStatus } from '../../../services/main/src/modules/package/cargo-solver.ts';

// Root manifests solved against one live crates.io sparse-index capture. The
// capture is `tests/live/cargo-crates-io.test.ts`; native Cargo 1.98.1 results
// for the same bytes come from `yarn package:cargo-oracle`.

export const CARGO_LIVE_REGISTRY = 'https://index.crates.io/';
export const CARGO_LIVE_HOST: CargoTriple = 'x86_64-unknown-linux-gnu';

export interface CargoLiveVariant { label: string; target: CargoTriple; features: string[];
  defaultFeatures: boolean; includeDev: boolean }
export interface CargoLiveScenario { id: string; cases: string[]; manifest: string;
  expected: CargoSolveStatus; variants: CargoLiveVariant[] }

const linux: CargoLiveVariant = { label: 'linux', target: 'x86_64-unknown-linux-gnu',
  features: [], defaultFeatures: true, includeDev: false };

function root(name: string, body: string, resolver = '2', extra = ''): string {
  return `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\nresolver = "${resolver}"\n${extra}\n${body}`;
}

const featureBody = `[dependencies]
serde_json = { version = "1", default-features = false, features = ["std"] }
rand = { version = "0.8", default-features = false, features = ["std", "std_rng"] }
getrandom = "0.2"
itoa = { version = "1", optional = true }

[build-dependencies]
cc = { version = "1", features = ["parallel"] }

[target.'cfg(windows)'.dependencies]
windows-targets = "0.52"

[target.'cfg(unix)'.dependencies]
libc = { version = "0.2", default-features = false }

[dev-dependencies]
serde = { version = "1", features = ["derive"] }

[features]
default = ["fast"]
fast = ["dep:itoa"]
ordered = ["serde_json/preserve_order"]
`;

const featureVariants: CargoLiveVariant[] = [
  linux,
  { ...linux, label: 'linux-dev', includeDev: true },
  { ...linux, label: 'linux-no-default', defaultFeatures: false },
  { ...linux, label: 'linux-ordered', features: ['ordered'] },
  { ...linux, label: 'windows', target: 'x86_64-pc-windows-msvc' },
  { ...linux, label: 'macos-dev', target: 'aarch64-apple-darwin', includeDev: true },
  { ...linux, label: 'wasm', target: 'wasm32-unknown-unknown' },
];

export const CARGO_LIVE_SCENARIOS: CargoLiveScenario[] = [
  { id: 'features-resolver2', cases: ['PKG01'], expected: 'solved',
    manifest: root('rezics-live-features', featureBody), variants: featureVariants },
  { id: 'features-resolver1', cases: ['PKG01'], expected: 'solved',
    manifest: root('rezics-live-features', featureBody, '1'),
    variants: [linux, { ...linux, label: 'linux-dev', includeDev: true },
      { ...linux, label: 'windows', target: 'x86_64-pc-windows-msvc' }] },
  { id: 'features-resolver3-msrv', cases: ['PKG01'], expected: 'solved',
    manifest: root('rezics-live-features', featureBody, '3', 'rust-version = "1.70"\n'),
    variants: [linux, { ...linux, label: 'windows', target: 'x86_64-pc-windows-msvc' }] },
  { id: 'semver-backtracking', cases: ['PKG02', 'PKG13'], expected: 'solved',
    manifest: root('rezics-live-backtrack', `[dependencies]
cc = "1"
shlex = "=1.0.0"
serde = "=1.0.100"
serde_json = "1"
itoa = ">=0.4, <1.0.5"
`), variants: [linux] },
  { id: 'links-backtracking', cases: ['PKG02'], expected: 'solved',
    manifest: root('rezics-live-links', `[dependencies]
rusqlite = ">=0.28, <0.30"
libsqlite3-sys = "0.25"
`), variants: [linux] },
  { id: 'yanked-range', cases: ['PKG02'], expected: 'solved',
    manifest: root('rezics-live-yanked', `[dependencies]
cc = ">=1.0.83, <=1.0.85"
`), variants: [linux] },
  { id: 'unsat-bucket', cases: ['PKG02', 'PKG13'], expected: 'unsatisfiable',
    manifest: root('rezics-live-unsat-bucket', `[dependencies]
serde = "=1.0.100"
serde_json = "=1.0.151"
`), variants: [linux] },
  { id: 'unsat-links', cases: ['PKG02', 'PKG13'], expected: 'unsatisfiable',
    manifest: root('rezics-live-unsat-links', `[dependencies]
rusqlite = "0.29"
libsqlite3-sys = "0.25"
`), variants: [linux] },
  { id: 'unsat-yanked', cases: ['PKG02', 'PKG13'], expected: 'unsatisfiable',
    manifest: root('rezics-live-unsat-yanked', `[dependencies]
cc = "=1.0.84"
`), variants: [linux] },
];

export function cargoIndexPath(name: string): string {
  const lower = name.toLowerCase();
  return lower.length === 1 ? `1/${lower}` : lower.length === 2 ? `2/${lower}`
    : lower.length === 3 ? `3/${lower[0]}/${lower}`
      : `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}
