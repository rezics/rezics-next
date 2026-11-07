/** Secret-free first-public journey table. The walk driver writes this into the Goal capabilities file. */
import { FIRST_PUBLIC_JOURNEY_PATHS, type JourneyId, type JourneyStatus } from './first-public-journeys-paths.ts';

export const CAPABILITIES_BEGIN = '<!-- first-public-journeys:begin -->';
export const CAPABILITIES_END = '<!-- first-public-journeys:end -->';

export type JourneyTableRow = {
  id: JourneyId;
  status: JourneyStatus;
  persona: string;
  elapsedMs: number;
  firstWrong?: string;
};

export type JourneyTableExtras = {
  devRevision?: string;
  stack?: { web: string; issuer: string; native: string; kernel: string };
  kernel?: { ok: boolean; detail: string };
  signIn?: { ok: boolean; detail: string };
  seedCause?: string;
  seedElapsedMs?: number;
  hydration?: { ok: boolean; detail: string; elapsedMs: number };
};

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function capabilitiesTableMarkdown(
  source: string,
  base: string,
  results: readonly JourneyTableRow[],
  extras: JourneyTableExtras = {},
): string {
  const currentDev = source !== '' && base !== '' && source === base;
  const observed = results.map((row) =>
    row.status !== 'PASS' || currentDev
      ? row
      : {
          ...row,
          status: 'FAIL' as const,
          firstWrong: `candidate source ${source.slice(0, 10)} cannot pass current-dev rows; integrated dev is ${(extras.devRevision || base).slice(0, 10) || 'unavailable'}`,
        },
  );
  const passing = observed.filter((row) => row.status === 'PASS').length;
  const failing = observed.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  const shared =
    observed.length > 0 && observed.every((row) => row.firstWrong && row.firstWrong === observed[0]?.firstWrong);
  const cause = slowest?.firstWrong ?? 'none';
  const lines = [
    '## Current-dev first-public journeys',
    '',
    `Observed source \`${source || 'unavailable'}\`; integrated dev \`${extras.devRevision || 'unavailable'}\`; common ancestor \`${base || 'unavailable'}\`. Walk command`,
    '`bun services/auth/scripts/dev-stack.ts walk -- bun apps/web/scripts/first-public-journeys-walk.ts`.',
    extras.stack
      ? `Operands: Web \`${extras.stack.web}\`, issuer \`${extras.stack.issuer}\`, native Auth \`${extras.stack.native}\`, Kernel \`${extras.stack.kernel}\`.`
      : 'The walk stack did not publish loopback origins.',
    extras.kernel ? `Kernel/JWKS probe: ${extras.kernel.detail}.` : '',
    extras.signIn ? `Sign-in probe: ${extras.signIn.detail}.` : '',
    extras.seedCause
      ? `Cross-media seed: ${escapeTableCell(extras.seedCause)}${
          extras.seedElapsedMs === undefined ? '' : ` (${formatElapsed(extras.seedElapsedMs)})`
        }. Mixed anonymous paths still ran; Semantic owns importer transport.`
      : extras.seedElapsedMs === undefined
        ? ''
        : `Cross-media seed elapsed ${formatElapsed(extras.seedElapsedMs)}.`,
    extras.hydration
      ? `Public /en hydration: ${extras.hydration.ok ? 'reached' : 'failed'} in ${formatElapsed(extras.hydration.elapsedMs)} (${escapeTableCell(extras.hydration.detail)}).`
      : '',
    'Secret-free evidence is `.temp/goal/performance/evidence.json` in this attempt. Phone and desktop viewports ran for each reached path.',
    '',
    `Hourly: **${passing}/17**.` +
      (slowest
        ? ` Slowest failing path: **${slowest.id}** (${formatElapsed(slowest.elapsedMs)} ${slowest.status}). First causal error: **\`${escapeTableCell(cause)}\`**.`
        : ' All 17 paths passed.'),
    shared && slowest
      ? 'No other reached product failure was observed under that shared launcher or sign-in cause.'
      : '',
    '',
    '| Path | User-visible journey | Persona | Elapsed | Result | First wrong result | Owner | Evidence |',
    '| ---- | -------------------- | ------- | ------: | ------ | ------------------ | ----- | -------- |',
  ];
  const byId = new Map(observed.map((row) => [row.id, row]));
  for (const path of FIRST_PUBLIC_JOURNEY_PATHS) {
    const row = byId.get(path.id);
    const elapsed = row ? formatElapsed(row.elapsedMs) : '0.000 s';
    const status = row?.status ?? 'FAIL-unreached';
    const persona = row?.persona ?? 'setup';
    const wrong = row?.firstWrong ? escapeTableCell(row.firstWrong) : status === 'PASS' ? '—' : 'not executed';
    lines.push(
      `| ${path.id} | ${path.title} | ${persona} | ${elapsed} | ${status} | ${wrong} | ${path.owner} | ${row ? `evidence.json row ${path.id}` : 'not recorded'} |`,
    );
  }
  return `${lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n')}\n`;
}
