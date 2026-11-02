import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Brief } from './types.ts';

export type StorybookProject = 'packages/ui' | 'apps/web';
export type StorybookServer = { project: StorybookProject; name: string; port: number; url: string; start: string };

function touches(paths: readonly string[], project: StorybookProject): boolean {
  const root = project.split('/');
  return paths.some((path) => {
    const segments = path.replace(/^\.\//, '').split('/');
    for (const [index, expected] of root.entries()) {
      const segment = segments[index];
      if (segment === '**') return true;
      if (segment === undefined || (segment !== expected && segment !== '*')) return false;
    }
    return true;
  });
}

/** The loopback port is derived from the worktree path, so resumes reconnect and concurrent trees do not share one. */
function port(worktree: string, project: StorybookProject): number {
  const digest = createHash('sha256')
    .update(`${resolve(worktree)}\0${project}`)
    .digest();
  return 10_000 + (digest.readUInt32BE(0) % 50_000);
}

/** The Storybook catalogues an interface task works against, each served from its own worktree. */
export function storybookServers(
  worktree: string | undefined,
  brief: Pick<Brief, 'kind' | 'paths'> | undefined,
): StorybookServer[] {
  if (!worktree || !brief) return [];
  const paths = brief.paths ?? [];
  const web = touches(paths, 'apps/web');
  const ui = touches(paths, 'packages/ui');
  // Web composes the UI catalogue through a ref, so a Web task also gets its own UI server.
  const projects: StorybookProject[] =
    web || (!ui && brief.kind === 'interface') ? ['packages/ui', 'apps/web'] : ui ? ['packages/ui'] : [];
  const root = resolve(worktree);
  const uiPort = port(root, 'packages/ui');
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return projects.map((project) => {
    const catalogue = project === 'apps/web' ? 'web' : 'ui';
    const own = port(root, project);
    const ref = project === 'apps/web' ? `STORYBOOK_UI_URL=http://127.0.0.1:${uiPort} ` : '';
    return {
      project,
      name: `storybook_${catalogue}`,
      port: own,
      url: `http://127.0.0.1:${own}/mcp`,
      start: `CACHE_DIR=${quote(join(root, '.temp', 'storybook-cache', catalogue))} ${ref}bun run --cwd ${project} storybook --host 127.0.0.1 --port ${own} --exact-port --ci`,
    };
  });
}

/** Prompt lines naming this worktree's Storybook servers; empty for work outside the interface catalogues. */
export function storybookPrompt(task: { worktree?: string; brief?: Pick<Brief, 'kind' | 'paths'> }): string {
  const servers = storybookServers(task.worktree, task.brief);
  if (!servers.length) return '';
  return [
    `This interface work uses the Storybook served from this worktree (docs/development/storybook.md, Agent access). Start it in the background and keep its log under this worktree's .temp/: ${servers.map((server) => `\`${server.start}\``).join(' and ')}.`,
    `Its MCP endpoints are ${servers.map((server) => `${server.project} \`${server.url}\``).join(' and ')}; a Codex session has them as MCP servers ${servers.map((server) => `\`${server.name}\``).join(' and ')}, which connect when the session starts or resumes; until then call the endpoint over HTTP. Use them by default to read components, docs and stories and to preview and test stories against your edits. These ports belong to this worktree: if one is taken, report the error line; never use another worktree's or a published catalogue. Chrome and Playwright stay available for behaviour the MCP does not cover; prefer \`apps/web/scripts/screenshots.ts\` for captures.`,
  ].join('\n');
}
