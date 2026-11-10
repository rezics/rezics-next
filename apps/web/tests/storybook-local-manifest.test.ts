import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { cleanupAll, ownNodeProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';

const root = resolve(import.meta.dir, '../../..');
type Entry = { id: string; name: string; type: string; title: string; tags: string[]; importPath: string };
type Component = {
  id: string;
  path: string;
  stories: { id: string; snippet?: string }[];
  reactDocgen?: { props: Record<string, unknown>; definedInFile: string };
};
type Reply = {
  error?: unknown;
  result: {
    isError?: boolean;
    serverInfo?: { name: string; version: string };
    tools?: { name: string; description: string; inputSchema: unknown }[];
    content?: { type: string; text?: string }[];
  };
};
const activeCustodies = new Set<ProcessCustody>();
const activeLogClosers = new Set<() => void>();

afterAll(async () => {
  await cleanupAll([
    ...[...activeCustodies].map((custody) => ({
      label: `Storybook manifest group ${custody.pid ?? 'without pid'}`,
      run: () => custody.close(),
      timeoutMs: 7000,
    })),
    ...[...activeLogClosers].map((closeLog) => ({
      label: 'Storybook manifest log descriptor',
      run: closeLog,
    })),
  ]);
});

async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port allocated');
  await new Promise<void>((done, reject) => socket.close((error) => (error ? reject(error) : done())));
  return address.port;
}

test('An own-worktree Storybook dev server supplies its real local MCP and component manifest for Web and UI without a published or static fallback', async () => {
  // Use the complete default catalogues. No browser, preview build, fixture server or alternate generator.
  const uiPort = await unusedPort();
  for (const { workspace, title, source, port } of [
    { workspace: 'packages/ui', title: 'Components/Cover', source: '/components/cover.stories.tsx', port: uiPort },
    {
      workspace: 'apps/web',
      title: 'Discovery/Search Refinement',
      source: '/stories/search-refinement.stories.tsx',
      port: await unusedPort(),
    },
  ]) {
    const directory = resolve(root, '.temp/storybook-local-manifest', workspace);
    mkdirSync(directory, { recursive: true });
    const origin = `http://127.0.0.1:${port}`;
    const logPath = resolve(directory, 'server.log');
    const log = openSync(logPath, 'w');
    let terminal: string | undefined;
    const stages: string[] = [];
    let child: ChildProcess | undefined;
    let custody: ProcessCustody | undefined;
    let logOpen = true;
    const closeLog = () => {
      if (!logOpen) return;
      closeSync(log);
      logOpen = false;
      activeLogClosers.delete(closeLog);
    };
    activeLogClosers.add(closeLog);
    await withCleanup(async () => {
      child = spawn(
        'bun',
        ['run', '--cwd', workspace, 'storybook', '--host', '127.0.0.1', '--port', String(port), '--exact-port', '--ci'],
        {
          cwd: root,
          // Web retains its UI ref, pointed at this attempt's UI endpoint (stopped between catalogues).
          env: {
            ...process.env,
            CACHE_DIR: resolve(directory, 'cache'),
            STORYBOOK_UI_URL: `http://127.0.0.1:${uiPort}`,
          },
          detached: true,
          stdio: ['ignore', log, log],
        },
      );
      custody = ownNodeProcess(child, { label: `Storybook manifest ${workspace}` });
      activeCustodies.add(custody);
      child.once('error', (error) => {
        terminal = error.message;
      });
      child.once('exit', (code, signal) => {
        terminal = `exit=${code}, signal=${signal}`;
      });
      closeLog();
      writeFileSync(resolve(directory, 'ownership.json'), JSON.stringify({ pid: child.pid, workspace, root, origin }));
      const startupDeadline = Date.now() + 120_000;
      while (
        !/Storybook[^\n]*started|Local:\s*http/.test(readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, ''))
      ) {
        if (terminal) throw new Error(`Storybook startup failed: ${terminal}; see ${logPath}`);
        if (Date.now() > startupDeadline) throw new Error(`Storybook startup not ready; see ${logPath}`);
        await Bun.sleep(100);
      }
      stages.push('server started');
      // A single request per step. A timeout is a failure, never a reason to launch another request/server.
      async function read(path: string, name: string, init?: RequestInit) {
        const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
        const body = await response.text();
        writeFileSync(resolve(directory, name), body);
        expect(response.status, `${workspace}: ${path}`).toBe(200);
        return { response, body };
      }
      const index = JSON.parse((await read('/index.json', 'index.json')).body) as { entries: Record<string, Entry> };
      stages.push('index ready');
      const entries = Object.values(index.entries);
      const selected = entries.find((entry) => entry.type === 'story' && entry.title === title);
      expect(selected?.importPath).toEndWith(source);
      let requestId = 0;
      let session: string | null = null;
      async function rpc(method: string, params: unknown, name: string) {
        const { response, body } = await read('/mcp', name, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
            ...(session ? { 'Mcp-Session-Id': session } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
        });
        session = response.headers.get('Mcp-Session-Id') ?? session;
        const reply = JSON.parse(body.startsWith('event:') ? body.split('\ndata: ')[1]! : body) as Reply;
        expect(reply.error).toBeUndefined();
        expect(reply.result.isError, body).not.toBe(true);
        return reply.result;
      }
      const initialized = await rpc(
        'initialize',
        {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'local-catalogue-regression', version: '1' },
        },
        'initialize.txt',
      );
      expect(initialized.serverInfo).toMatchObject({ name: '@storybook/addon-mcp', version: '11.0.0-alpha.8' });
      const { tools } = await rpc('tools/list', {}, 'tools.txt');
      for (const name of ['docs-list', 'docs-show', 'docs-show-story']) {
        const tool = tools?.find((candidate) => candidate.name === name);
        expect(tool?.description.length).toBeGreaterThan(20);
        expect(tool?.inputSchema).toBeDefined();
      }
      const { response, body } = await read('/manifests/components.json', 'components.json');
      expect(response.headers.get('content-type')).toContain('application/json');
      const manifest = JSON.parse(body) as { components: Record<string, Component>; meta: { docgen: string } };
      expect(manifest.meta.docgen).toBe('react-docgen');
      const components = Object.values(manifest.components);
      const component = components.find((candidate) => candidate.stories.some((story) => story.id === selected!.id));
      expect(component?.path).toEndWith(source);
      expect(component?.reactDocgen?.definedInFile).toStartWith(`${root}/${workspace}/src/`);
      expect(Object.keys(component?.reactDocgen?.props ?? {}).length).toBeGreaterThan(0);
      // Every manifest-tagged canonical story remains reachable, including nested owner stories.
      const storyIds = new Set(components.flatMap((candidate) => candidate.stories.map((story) => story.id)));
      const expected = entries.filter((entry) => entry.type === 'story' && entry.tags.includes('manifest'));
      expect(expected.length).toBeGreaterThan(100);
      for (const entry of expected) expect(storyIds.has(entry.id), entry.id).toBe(true);
      stages.push('manifest ready');
      const text = (result: Reply['result']) =>
        result.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n') ?? '';
      const listed = text(
        await rpc('tools/call', { name: 'docs-list', arguments: { withStoryIds: true } }, 'docs-list.txt'),
      );
      expect(listed).toContain(component!.id);
      expect(listed).toContain(selected!.id);
      if (workspace === 'apps/web') {
        const overview = entries.find((entry) => entry.type === 'docs' && entry.title === 'Overview');
        expect(overview).toBeDefined();
        expect(listed).toContain(overview!.id);
      }
      const scope = (name: string) => {
        const schema = tools?.find((tool) => tool.name === name)?.inputSchema as {
          properties?: Record<string, unknown>;
        };
        return schema.properties?.storybookId ? { storybookId: 'local' } : {};
      };
      const shown = text(
        await rpc(
          'tools/call',
          { name: 'docs-show', arguments: { id: component!.id, ...scope('docs-show') } },
          'docs-show.txt',
        ),
      );
      expect(shown).toContain(component!.id);
      expect(shown).toContain(workspace === 'apps/web' ? 'query' : 'subject');
      const story = text(
        await rpc(
          'tools/call',
          { name: 'docs-show-story', arguments: { storyId: selected!.id, ...scope('docs-show-story') } },
          'docs-show-story.txt',
        ),
      );
      expect(story).toContain(selected!.name);
      const snippet = component!.stories.find((story) => story.id === selected!.id)?.snippet;
      expect(snippet?.length).toBeGreaterThan(0);
      expect(story).toContain(snippet!);
      stages.push('local MCP component and story selected');
    }, [
      {
        label: `Storybook manifest ${workspace} process group and terminal receipt`,
        timeoutMs: 8000,
        run: async () => {
          let custodyError: unknown;
          try {
            await custody?.close();
          } catch (error) {
            custodyError = error;
          }
          try {
            writeFileSync(resolve(directory, 'terminal.json'), JSON.stringify({ stages, terminal }));
          } catch (error) {
            if (custodyError) throw new AggregateError([custodyError, error], 'Storybook cleanup and receipt failed');
            throw error;
          }
          if (custodyError) throw custodyError;
        },
      },
      { label: `Storybook manifest ${workspace} log descriptor`, run: closeLog },
    ]);
  }
}, 600_000);
