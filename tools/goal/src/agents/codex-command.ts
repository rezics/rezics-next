import { join } from 'node:path';
import defaults from '../../defaults.json';
import type { AgentLaunchOptions } from '../agents.ts';
import type { Profile } from '../types.ts';

export function codexCommand(options: AgentLaunchOptions): [string, string[]] {
  const resolver = options.resolver === true;
  if (resolver) {
    if (options.resumeSession) throw new Error('Train resolution requires a fresh session');
    options = { ...options, consultation: true, research: false, readOnly: false };
  }
  const { profile, pool, worktree, prompt } = options;
  const codex = options.codex ?? defaults.codex;
  // The account's MCP servers (browser, Playwright) stay available; a launch only adds its own HTTP servers.
  const mcp = (options.consultation ? [] : (options.mcpServers ?? [])).flatMap((server) => [
    '-c',
    `mcp_servers.${JSON.stringify(server.name)}.url=${JSON.stringify(server.url)}`,
  ]);
  return [
    pool.command,
    [
      'exec',
      ...(options.consultation
        ? [
            '--skip-git-repo-check',
            '--ignore-user-config',
            '-c',
            'project_doc_max_bytes=0',
            '-c',
            'web_search="disabled"',
          ]
        : []),
      // `exec resume` refuses -C and -s, which are exec options: they go before the subcommand (every check-wake
      // resume failed with "unexpected argument '-C'" and looped each minute on 2026-10-29).
      ...(options.resumeSession
        ? ['-C', worktree, ...(options.readOnly ? ['-s', 'read-only'] : []), 'resume', options.resumeSession]
        : []),
      '--json',
      '-m',
      profile.model,
      '-c',
      `model_reasoning_effort=${profile.effort}`,
      '-c',
      `model_auto_compact_token_limit=${profile.model.includes('luna') ? codex.compactTokens.luna : codex.compactTokens.sol}`,
      '-c',
      `tool_output_token_limit=${codex.toolOutputTokens}`,
      '-c',
      'features.unified_exec=true',
      '-c',
      `background_terminal_max_timeout=${codex.backgroundTerminalMaxTimeoutMs}`,
      '-c',
      // Only local settings choose the tier, including when an attempt keeps an older routing profile.
      `service_tier=${JSON.stringify(codex.serviceTier)}`,
      ...(profile.model.includes('sol') ? ['-c', `model_context_window=${codex.solContextWindow}`] : []),
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.multi_agent_v2=false',
      ...mcp,
      ...(resolver
        ? ['-s', 'workspace-write', '-c', 'approval_policy="never"']
        : options.readOnly
          ? [...(options.resumeSession ? [] : ['-s', 'read-only']), '-c', 'approval_policy="never"']
          : ['--dangerously-bypass-approvals-and-sandbox']),
      ...(options.research ? ['-c', 'web_search="live"'] : []),
      ...(!options.readOnly && !resolver
        ? ['--output-schema', join(import.meta.dir, '../../worker-result.schema.json')]
        : []),
      ...(options.resumeSession ? [] : ['-C', worktree]),
      '--',
      options.promptViaStdin ? '-' : prompt,
    ],
  ];
}

/** Preserve the legacy brief's explicit model pin independently of the selected route. */
export function pinnedCodexProfile(model: string, requestedEffort: string | undefined, route: Profile): Profile {
  if (!/^gpt-[a-z0-9.-]+$/.test(model)) throw new Error(`brief model must be a Codex model: ${model}`);
  const effort = (requestedEffort ?? 'high') as Profile['effort'];
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`invalid brief effort: ${effort}`);
  return {
    cli: 'codex',
    model,
    effort,
    poolClass: route.cli === 'codex' ? route.poolClass : 'codex',
    ...(route.serviceTier ? { serviceTier: route.serviceTier } : {}),
  };
}
