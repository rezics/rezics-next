// Cargo platform predicates: a bare target name or `cfg(...)` evaluated against
// the exact `rustc 1.98.1 --print cfg --target <triple>` table for each admitted
// triple. Only those triples are admitted; nothing else is guessed.

export class CargoCfgSyntax extends Error {}

const TABLES = {
  'x86_64-unknown-linux-gnu': 'debug_assertions panic="unwind" target_abi="" target_arch="x86_64" target_endian="little" target_env="gnu" target_family="unix" target_feature="fxsr" target_feature="sse" target_feature="sse2" target_has_atomic="16" target_has_atomic="32" target_has_atomic="64" target_has_atomic="8" target_has_atomic="ptr" target_has_atomic_primitive_alignment="16" target_has_atomic_primitive_alignment="32" target_has_atomic_primitive_alignment="64" target_has_atomic_primitive_alignment="8" target_has_atomic_primitive_alignment="ptr" target_os="linux" target_pointer_width="64" target_vendor="unknown" unix',
  'x86_64-pc-windows-msvc': 'debug_assertions panic="unwind" target_abi="" target_arch="x86_64" target_endian="little" target_env="msvc" target_family="windows" target_feature="cmpxchg16b" target_feature="fxsr" target_feature="sse" target_feature="sse2" target_feature="sse3" target_has_atomic="128" target_has_atomic="16" target_has_atomic="32" target_has_atomic="64" target_has_atomic="8" target_has_atomic="ptr" target_has_atomic_primitive_alignment="128" target_has_atomic_primitive_alignment="16" target_has_atomic_primitive_alignment="32" target_has_atomic_primitive_alignment="64" target_has_atomic_primitive_alignment="8" target_has_atomic_primitive_alignment="ptr" target_os="windows" target_pointer_width="64" target_vendor="pc" windows',
  'aarch64-apple-darwin': 'debug_assertions panic="unwind" target_abi="" target_arch="aarch64" target_endian="little" target_env="" target_family="unix" target_feature="aes" target_feature="crc" target_feature="dit" target_feature="dotprod" target_feature="dpb" target_feature="dpb2" target_feature="fcma" target_feature="fhm" target_feature="flagm" target_feature="fp16" target_feature="frintts" target_feature="jsconv" target_feature="lor" target_feature="lse" target_feature="neon" target_feature="paca" target_feature="pacg" target_feature="pan" target_feature="pmuv3" target_feature="ras" target_feature="rcpc" target_feature="rcpc2" target_feature="rdm" target_feature="sb" target_feature="sha2" target_feature="sha3" target_feature="ssbs" target_feature="vh" target_has_atomic="128" target_has_atomic="16" target_has_atomic="32" target_has_atomic="64" target_has_atomic="8" target_has_atomic="ptr" target_has_atomic_primitive_alignment="128" target_has_atomic_primitive_alignment="16" target_has_atomic_primitive_alignment="32" target_has_atomic_primitive_alignment="64" target_has_atomic_primitive_alignment="8" target_has_atomic_primitive_alignment="ptr" target_os="macos" target_pointer_width="64" target_vendor="apple" unix',
  'wasm32-unknown-unknown': 'debug_assertions panic="abort" target_abi="" target_arch="wasm32" target_endian="little" target_env="" target_family="wasm" target_feature="bulk-memory" target_feature="multivalue" target_feature="mutable-globals" target_feature="nontrapping-fptoint" target_feature="reference-types" target_feature="sign-ext" target_has_atomic="16" target_has_atomic="32" target_has_atomic="64" target_has_atomic="8" target_has_atomic="ptr" target_has_atomic_primitive_alignment="16" target_has_atomic_primitive_alignment="32" target_has_atomic_primitive_alignment="64" target_has_atomic_primitive_alignment="8" target_has_atomic_primitive_alignment="ptr" target_os="unknown" target_pointer_width="32" target_vendor="unknown"',
} as const;
export type CargoTriple = keyof typeof TABLES;
export const CARGO_TRIPLES = Object.keys(TABLES) as CargoTriple[];

const cfgSets = new Map<CargoTriple, Set<string>>(CARGO_TRIPLES.map(triple =>
  [triple, new Set(TABLES[triple].split(' '))]));

type Expr = { kind: 'all' | 'any'; items: Expr[] } | { kind: 'not'; item: Expr }
  | { kind: 'key'; key: string; value: string | null };

function parseCfg(text: string): Expr {
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '')) at++; };
  const ident = (): string => {
    space();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (!match) throw new CargoCfgSyntax(`invalid cfg ${text}`);
    at += match[0].length;
    return match[0];
  };
  const expr = (depth: number): Expr => {
    if (depth > 16) throw new CargoCfgSyntax('cfg nesting limit');
    const name = ident();
    space();
    if (text[at] === '(' && (name === 'all' || name === 'any' || name === 'not')) {
      at++;
      const items: Expr[] = [];
      space();
      while (text[at] !== ')') {
        items.push(expr(depth + 1));
        space();
        if (text[at] === ',') { at++; space(); } else if (text[at] !== ')') {
          throw new CargoCfgSyntax(`invalid cfg ${text}`);
        }
      }
      at++;
      if (name === 'not') {
        if (items.length !== 1) throw new CargoCfgSyntax(`invalid not() ${text}`);
        return { kind: 'not', item: items[0]! };
      }
      return { kind: name as 'all' | 'any', items };
    }
    if (text[at] === '=') {
      at++;
      space();
      const match = /^"([^"\\]*)"/.exec(text.slice(at));
      if (!match) throw new CargoCfgSyntax(`invalid cfg value ${text}`);
      at += match[0].length;
      return { kind: 'key', key: name, value: match[1]! };
    }
    return { kind: 'key', key: name, value: null };
  };
  const result = expr(0);
  space();
  if (at !== text.length) throw new CargoCfgSyntax(`invalid cfg ${text}`);
  return result;
}

function evaluate(expr: Expr, cfg: Set<string>): boolean {
  switch (expr.kind) {
    case 'all': return expr.items.every(item => evaluate(item, cfg));
    case 'any': return expr.items.some(item => evaluate(item, cfg));
    case 'not': return !evaluate(expr.item, cfg);
    case 'key': return cfg.has(expr.value === null ? expr.key : `${expr.key}="${expr.value}"`);
  }
}

const TRIPLE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Validates a platform predicate without evaluating it. */
export function checkCargoPlatform(platform: string): void {
  if (platform.startsWith('cfg(') && platform.endsWith(')')) parseCfg(platform.slice(4, -1));
  else if (!TRIPLE.test(platform)) throw new CargoCfgSyntax(`invalid platform ${platform}`);
}

export function cargoPlatformMatches(platform: string | null, triple: CargoTriple): boolean {
  if (platform === null) return true;
  if (platform.startsWith('cfg(') && platform.endsWith(')')) {
    return evaluate(parseCfg(platform.slice(4, -1)), cfgSets.get(triple)!);
  }
  if (!TRIPLE.test(platform)) throw new CargoCfgSyntax(`invalid platform ${platform}`);
  return platform === triple;
}
