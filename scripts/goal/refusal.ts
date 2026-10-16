import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryGuards } from '../qa/repository-guards.ts';
import { readReviewProof } from './review-proof.ts';

export type LandingRefusal =
  | { kind: 'worker'; check: string; message: string; output: string }
  | { kind: 'manager'; reason: string };

/** Consume the landing's evidence, never infer a defect from a runner or review failure. */
export function classifyLandingRefusal(output: string): LandingRefusal {
  const text = readFileSync(output, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const reason = lines[0] ?? 'landing stopped';
  const heading = reason.replace(/^G-\d+\s+/, '');
  let check: string;
  let failures: string[];
  if (heading === 'introduced type errors; not merging:') {
    check = 'pre-merge type check';
    failures = lines.slice(1);
  } else if (heading === 'introduced unit failures; not merging:') {
    failures = [];
    let errorLines = 0;
    for (const line of lines.slice(1)) {
      if (line === 'inherited on main:') break;
      if (/^  \S|^    \(fail\)/.test(line)) { errorLines = 0; failures.push(line); }
      else if (line.trim() && errorLines++ < 3) failures.push(line);
    }
    const guards = new Set<string>(repositoryGuards.map(guard => guard.file));
    check = failures.some(line => guards.has(line.trim())) ? 'repository guard (unit gate)' : 'unit gate';
  } else if (heading === 'blocking review tests committed for the fix:' || heading === 'committed review tests did not pass') {
    check = 'review finding with a failing test';
    failures = reviewFailures(join(output, '..'));
    if (!failures.length) return { kind: 'manager', reason };
  } else return { kind: 'manager', reason };
  return { kind: 'worker', check, output,
    message: [`Check: ${check}`, ...failures.filter(line => line.trim()).slice(0, 58), `Whole output: ${output}`].join('\n') };
}

function reviewFailures(directory: string): string[] {
  const proof = readReviewProof(directory);
  return (proof?.failures ?? []).filter(test => proof?.results[test.file] === 'failed' && test.assertionReached === 'yes')
    .flatMap(test => [`${test.file}: ${test.name}`, ...test.detail.split(/\r?\n/).slice(0, 3)]);
}
