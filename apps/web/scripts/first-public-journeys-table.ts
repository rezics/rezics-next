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
  stack?: { web: string; issuer: string; native: string; kernel: string };
  kernel?: { ok: boolean; detail: string };
  signIn?: { ok: boolean; detail: string };
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
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  const shared =
    results.length > 0 && results.every((row) => row.firstWrong && row.firstWrong === results[0]?.firstWrong);
  const cause = slowest?.firstWrong ?? 'none';
  const lines = [
    '## Current-dev first-public journeys',
    '',
    `Observed source \`${source.slice(0, 10)}\` on base \`${base.slice(0, 10)}\`. Walk command`,
    '`bun services/auth/scripts/dev-stack.ts walk -- bun apps/web/scripts/first-public-journeys-walk.ts`.',
    extras.stack
      ? `Operands: Web \`${extras.stack.web}\`, issuer \`${extras.stack.issuer}\`, native Auth \`${extras.stack.native}\`, Kernel \`${extras.stack.kernel}\`.`
      : 'The walk stack did not publish loopback origins.',
    extras.kernel ? `Kernel/JWKS probe: ${extras.kernel.detail}.` : '',
    extras.signIn ? `Sign-in probe: ${extras.signIn.detail}.` : '',
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
    '| Path | User-visible journey | Persona | Elapsed | Result | First wrong result | Owner |',
    '| ---- | -------------------- | ------- | ------: | ------ | ------------------ | ----- |',
  ];
  const byId = new Map(results.map((row) => [row.id, row]));
  for (const path of FIRST_PUBLIC_JOURNEY_PATHS) {
    const row = byId.get(path.id);
    const elapsed = row ? formatElapsed(row.elapsedMs) : '0.000 s';
    const status = row?.status ?? 'FAIL-unreached';
    const persona = row?.persona ?? 'setup';
    const wrong = row?.firstWrong ? escapeTableCell(row.firstWrong) : status === 'PASS' ? '—' : 'not executed';
    lines.push(`| ${path.id} | ${path.title} | ${persona} | ${elapsed} | ${status} | ${wrong} | ${path.owner} |`);
  }
  return `${lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n')}\n`;
}
