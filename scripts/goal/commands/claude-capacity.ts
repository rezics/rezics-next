import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseBrief, validateBrief } from '../briefs.ts';
import { git, readLedger, root } from '../ledger.ts';
import { isClaudeCode } from '../types.ts';
import { briefDigest, capacityDecision, capacityFingerprint, capacitySourceFiles, capacityStatus, claudeGrantError,
  coordinateClaudeCapacity, editCapacityPolicy, refreshClaudeCapacity } from '../claude-capacity.ts';

export const usage = 'Usage: goalctl claude-capacity refresh|status|tick|start --reviewed-sha <sha> --reviewed-by codex-1/xhigh'
  + ' | stop | allow <brief> --purpose frontend-implementation|frontend-research --research <task> --reviewed'
  + ' | revoke <task> | release --verified-completion <evidence> | reserve';

export default async function claudeCapacity(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const options = (names: string[]) => {
    const values: Record<string, string> = {};
    for (let at = 0; at < rest.length; at += 2) {
      const key = rest[at]!, value = rest[at + 1];
      if (!names.includes(key) || values[key] !== undefined || !value || value.startsWith('--')) throw new Error(usage);
      values[key] = value;
    }
    if (names.some(name => !values[name])) throw new Error(usage);
    return values;
  };
  if (['status', 'refresh', 'tick', 'stop', 'reserve'].includes(action ?? '') && rest.length) throw new Error(usage);
  switch (action) {
    case 'status': console.log(JSON.stringify(capacityStatus(), null, 2)); return 0;
    case 'refresh': {
      const cache = await refreshClaudeCapacity();
      const status = capacityStatus();
      console.log(JSON.stringify({ ...status, cache, decision: capacityDecision(cache, status.reserveReleased) }, null, 2));
      return cache.current.error ? 1 : 0;
    }
    case 'tick': await coordinateClaudeCapacity(); console.log(JSON.stringify(capacityStatus(), null, 2)); return 0;
    case 'start': {
      const values = options(['--reviewed-sha', '--reviewed-by']);
      const sha = git(process.cwd(), ['rev-parse', 'HEAD']);
      if (values['--reviewed-by'] !== 'codex-1/xhigh' || values['--reviewed-sha'] !== sha
        || git(process.cwd(), ['status', '--porcelain', '--', ...capacitySourceFiles])) {
        throw new Error('Start requires independent codex-1/xhigh review of this clean source HEAD');
      }
      editCapacityPolicy(policy => { policy.review = { sha, by: 'codex-1/xhigh', fingerprint: capacityFingerprint() }; policy.enabled = true; });
      break;
    }
    case 'stop': editCapacityPolicy(policy => { policy.enabled = false; }); await coordinateClaudeCapacity(); break;
    case 'reserve': editCapacityPolicy(policy => { delete policy.aboutCompletion; }); break;
    case 'release': {
      const values = options(['--verified-completion']);
      const evidence = values['--verified-completion']!.trim();
      if (evidence.length < 12) throw new Error('Provide explicit verified about completion evidence; absence or idle state is insufficient');
      editCapacityPolicy(policy => { policy.aboutCompletion = { verifiedAt: new Date().toISOString(), evidence }; });
      break;
    }
    case 'allow': {
      const file = resolve(rest[0] ?? '');
      const flags = rest.slice(1);
      if (!file.startsWith(`${resolve(root)}/`) || !flags.includes('--reviewed')) throw new Error(usage);
      const purposeAt = flags.indexOf('--purpose'), researchAt = flags.indexOf('--research');
      const purpose = flags[purposeAt + 1], researchTask = flags[researchAt + 1];
      if (flags.length !== 5 || purposeAt < 0 || researchAt < 0 || !researchTask
        || !['frontend-implementation', 'frontend-research'].includes(purpose ?? '')) throw new Error(usage);
      const brief = parseBrief(readFileSync(file, 'utf8'));
      const errors = validateBrief(brief);
      if (errors.length || !isClaudeCode(brief.engine ?? '') || brief.land === 'auto') {
        throw new Error('Allow requires a valid reviewed Claude brief without automatic landing');
      }
      editCapacityPolicy(policy => {
        policy.tasks[brief.id] = { brief: file, digest: briefDigest(file),
          purpose: purpose as 'frontend-implementation' | 'frontend-research', researchTask };
        const error = claudeGrantError(policy, brief.id, readLedger());
        if (error) throw new Error(error);
      });
      break;
    }
    case 'revoke': {
      if (rest.length !== 1 || !/^G-\d{3,}$/.test(rest[0]!)) throw new Error(usage);
      editCapacityPolicy(policy => { delete policy.tasks[rest[0]!]; }); break;
    }
    default: throw new Error(usage);
  }
  console.log(JSON.stringify(capacityStatus(), null, 2));
  return 0;
}
