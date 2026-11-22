import type {
  CatalogPackage,
  CatalogRelease,
  InstalledOverlayExtension,
  OverlayPanel,
  ReleaseRef,
} from '@rezics/launcher-contract';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fabricModJar } from '../../../../packages/launcher-core/test/fixtures/mod-jar';
import { createLauncherHost } from './host';

test.skipIf(process.platform === 'win32')(
  'reviews exact catalogue packages and updates a running Overlay through the CLI',
  async () => {
    const scratch = resolve(import.meta.dir, '../../.temp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'automation-catalog-'));
    const dataDir = join(root, 'profile');
    const request = join(root, 'Package command.json');
    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    const packages = new Map<string, CatalogPackage>();
    const releases = new Map<string, CatalogRelease>();
    const artifacts = new Map<string, Buffer>();
    const extensionEvents: string[] = [];
    const modEvents: string[] = [];
    const downloads: string[] = [];
    const packagePath = '/v1/launcher/packages';
    let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

    function publish(
      packageId: string,
      releaseId: string,
      title: string,
      body: Buffer,
      compatibility: CatalogRelease['compatibility'],
      requires: ReleaseRef[] = [],
    ) {
      const url = `https://artifacts.example.test/${packageId}/${releaseId}`;
      const release = {
        packageId,
        id: releaseId,
        version: releaseId,
        compatibility,
        requires,
        artifact: { url, size: body.length, sha256: createHash('sha256').update(body).digest('hex') },
      };
      packages.set(packageId, { id: packageId, title, publisher: 'Fixture', summary: '', kind: compatibility.kind });
      releases.set(`${packageId}/${releaseId}`, release);
      artifacts.set(url, body);
      return { packageId, releaseId };
    }

    const panels: ReleaseRef[] = [];
    for (let index = 0; index < 9; index++) {
      const title = `Guide ${index}`;
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, title, text: title, destination: 'guide' }));
      panels.push(
        publish(
          `fixture.guide${index}`,
          '1.0.0',
          title,
          body,
          { kind: 'overlay-panel', launcherRange: '^0.1.0' },
          index > 6 ? [panels[index - 1]!] : [],
        ),
      );
    }
    const first = panels[0]!;
    const required = panels[6]!;
    const extension = panels[8]!;
    const originalRelease = releases.get(`${extension.packageId}/${extension.releaseId}`)!;
    const releasedBody = artifacts.get(originalRelease.artifact.url)!;
    const jar = fabricModJar('curated_fixture', '1.0.0');
    const mod = publish('fixture.mod', '1.0.0', 'Curated mod', jar, {
      kind: 'minecraft-mod',
      loader: 'fabric',
      gameVersion: '1.21.1',
    });
    let unavailableRelease: string | undefined;
    const fixtureFetch = (async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'artifacts.example.test') {
        downloads.push(url.href);
        return new Response(new Uint8Array(artifacts.get(url.href)!));
      }
      const [id, branch, version] = url.pathname.slice(packagePath.length + 1).split('/');
      if (!id) {
        return Response.json({
          items: [...packages.values()].filter((pkg) => pkg.kind === url.searchParams.get('kind')),
          nextCursor: null,
        });
      }
      if (!branch) return Response.json(packages.get(id));
      if (!version)
        return Response.json({
          items: [...releases.values()].filter(({ packageId }) => packageId === id),
          nextCursor: null,
        });
      const key = `${id}/${version}`;
      if (key === unavailableRelease) return new Response(null, { status: 503 });
      const release = releases.get(key);
      return release ? Response.json(release) : new Response(null, { status: 404 });
    }) as typeof fetch;

    async function cli(command: string, input?: object | string, failure?: RegExp) {
      const argument = typeof input === 'object' ? request : input;
      if (typeof input === 'object') await writeFile(request, JSON.stringify(input));
      const child = Bun.spawn(
        [process.execPath, script, '--data-dir', dataDir, command, ...(argument ? [argument] : [])],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          signal: AbortSignal.timeout(10_000),
        },
      );
      const [code, stdout, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, error).toBe(failure ? 1 : 0);
      if (failure) {
        expect(error).toMatch(failure);
        return;
      }
      return JSON.parse(stdout);
    }

    try {
      host = await createLauncherHost({
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://web.example.test',
        launcherVersion: '0.1.0',
        openExternal: async () => {},
        fetch: fixtureFetch,
        automation: {
          onExtensionsChanged: () => extensionEvents.push('changed'),
          onModFolderChanged: (id) => modEvents.push(id),
        },
      });
      const catalog = await cli('search-rezics-packages', { kind: 'overlay-panel', query: 'guide' });
      expect(catalog.items).toHaveLength(9);
      expect(await cli('rezics-package-releases', { packageId: extension.packageId })).toEqual({
        items: [originalRelease],
        nextCursor: null,
      });
      for (const ref of panels.slice(0, 6)) await host.core.installPackage(ref);
      const executable = join(root, 'game.sh');
      await writeFile(executable, '#!/bin/sh\nexec sleep 45\n', { mode: 0o700 });
      const instance = await host.core.importInstance({ kind: 'local', name: 'Overlay fixture', executable });
      const session = await cli('start-game', instance.id);
      expect(session.panels).toHaveLength(6);

      const reviewed = await cli('preview-rezics-package', extension);
      expect(reviewed.changes).toMatchObject(panels.slice(6).map((ref) => ({ ...ref, action: 'install' })));
      expect(reviewed.changes.at(-1).sha256).toBe(originalRelease.artifact.sha256);
      expect(reviewed.changes.at(-1).requires).toEqual([panels[7]]);
      expect(downloads).toHaveLength(6);
      const key = `${extension.packageId}/${extension.releaseId}`;
      unavailableRelease = key;
      await cli('install-rezics-package', reviewed, /Catalog request failed \(503\)/);
      unavailableRelease = undefined;
      releases.delete(key);
      await cli(
        'install-rezics-package',
        reviewed,
        /selected REZICS release fixture\.guide8 \(1\.0\.0\) is unavailable/,
      );
      expect(downloads).toHaveLength(6);
      releases.set(key, { ...originalRelease, artifact: { ...originalRelease.artifact, sha256: 'a'.repeat(64) } });
      await cli('install-rezics-package', reviewed, /Preview the installation again/);
      expect(downloads).toHaveLength(6);
      releases.set(key, originalRelease);
      const requirementKey = `${panels[7]!.packageId}/${panels[7]!.releaseId}`;
      const requirement = releases.get(requirementKey)!;
      releases.delete(requirementKey);
      await cli(
        'install-rezics-package',
        reviewed,
        /required REZICS release fixture\.guide7 \(1\.0\.0\) is unavailable/,
      );
      expect(downloads).toHaveLength(6);
      releases.set(requirementKey, requirement);
      artifacts.set(originalRelease.artifact.url, Buffer.alloc(releasedBody.length, 65));
      await cli('install-rezics-package', reviewed, /published size and digest/);
      expect(await cli('list-overlay-extensions')).toHaveLength(6);
      expect((await cli('game-status')).session.panels).toHaveLength(6);
      expect(extensionEvents).toEqual([]);
      artifacts.set(originalRelease.artifact.url, releasedBody);
      await cli('install-rezics-package', reviewed);
      const installed: InstalledOverlayExtension[] = await cli('list-overlay-extensions');
      expect(installed.map(({ visible }) => visible)).toEqual([true, true, true, true, true, true, true, true, false]);
      const orderRevision = installed[0]!.orderRevision;
      const ids = installed.map(({ id }) => id);
      const moved = [extension.packageId, ...ids.slice(0, -1)];
      await cli(
        'reorder-overlay-extensions',
        { packageIds: [...moved.slice(0, -1), moved[0]], orderRevision },
        /exactly once/,
      );
      const readsBeforeReorder = downloads.length;
      expect(await cli('reorder-overlay-extensions', { packageIds: moved, orderRevision })).toEqual({
        packageIds: moved,
        status: 'applied',
      });
      const reordered: InstalledOverlayExtension[] = await cli('list-overlay-extensions');
      expect(reordered.map(({ id }) => id)).toEqual(moved);
      expect(reordered[0]).toMatchObject({ id: extension.packageId, enabled: true, visible: true });
      expect(reordered.at(-1)).toMatchObject({ enabled: true, visible: false });
      expect(reordered.map(({ revision }) => revision)).toEqual([
        installed.at(-1)!.revision,
        ...installed.slice(0, -1).map(({ revision }) => revision),
      ]);
      expect((await cli('game-status')).session).toMatchObject({
        sessionId: session.sessionId,
        panels: moved.slice(0, 8).map((id) => ({ id })),
      });
      await cli('reorder-overlay-extensions', { packageIds: ids, orderRevision }, /extension order changed/);
      await cli('reorder-overlay-extensions', { packageIds: ids, orderRevision: reordered[0]!.orderRevision });
      expect(downloads).toHaveLength(readsBeforeReorder);
      const children = installed.find(({ id }) => id === required.packageId)!;
      await cli('uninstall-overlay-extension', { packageId: children.id, revision: children.revision }, /requires/);
      const { revision } = installed[0]!;
      await cli('set-overlay-extension-enabled', { packageId: first.packageId, revision, enabled: false });
      await cli(
        'set-overlay-extension-enabled',
        { packageId: first.packageId, revision, enabled: true },
        /extension changed/,
      );
      const after: InstalledOverlayExtension[] = await cli('list-overlay-extensions');
      expect(after.at(-1)).toMatchObject({ id: extension.packageId, visible: true });
      const active = (await cli('game-status')).session;
      expect(active.sessionId).toBe(session.sessionId);
      expect(active.panels.map(({ id }: { id: string }) => id)).toEqual(
        after.filter(({ visible }) => visible).map(({ id }) => id),
      );
      const retained = after.at(-1)!;
      await cli('uninstall-overlay-extension', { packageId: retained.id, revision: retained.revision });
      expect((await cli('game-status')).session.panels).toHaveLength(7);
      expect(extensionEvents).toEqual(['changed', 'changed', 'changed', 'changed', 'changed']);

      const ledgerPath = join(dataDir, 'extensions', 'installed.json');
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        packages: { id: string; panel: OverlayPanel; panelDigest?: string; integrity?: unknown }[];
      };
      const firstRecord = ledger.packages[0]!;
      const legacy = ledger.packages[1]!;
      delete legacy.panelDigest;
      delete legacy.integrity;
      const intactPanel = { ...firstRecord.panel };
      firstRecord.panel.text = 'X' + intactPanel.text.slice(1);
      const damagedLedger = JSON.stringify(ledger);
      await writeFile(ledgerPath, damagedLedger);
      const [damaged, legacyView] = (await cli('list-overlay-extensions')) as InstalledOverlayExtension[];
      expect(damaged).toMatchObject({ fileIssue: 'damaged', enabled: false, visible: false });
      expect(legacyView).toMatchObject({ id: legacy.id, visible: true });
      expect(legacyView?.fileIssue).toBeUndefined();
      await cli(
        'set-overlay-extension-enabled',
        { packageId: damaged!.id, enabled: true, revision: damaged!.revision },
        /Repair this Overlay extension/,
      );
      const repair = { packageId: first.packageId, revision: damaged!.revision };
      await cli('repair-overlay-extension', { ...repair, revision: after[0]!.revision }, /extension changed/);
      const firstKey = `${first.packageId}/${first.releaseId}`;
      const firstRelease = releases.get(firstKey)!;
      const firstBody = artifacts.get(firstRelease.artifact.url)!;
      const readsBeforeRepair = downloads.length;
      releases.delete(firstKey);
      await cli(
        'repair-overlay-extension',
        repair,
        /installed REZICS release fixture\.guide0 \(1\.0\.0\) is unavailable/,
      );
      releases.set(firstKey, { ...firstRelease, artifact: { ...firstRelease.artifact, sha256: 'b'.repeat(64) } });
      await cli('repair-overlay-extension', repair, /no longer matches/);
      expect(downloads).toHaveLength(readsBeforeRepair);
      releases.set(firstKey, firstRelease);
      artifacts.set(firstRelease.artifact.url, Buffer.alloc(firstBody.length, 65));
      await cli('repair-overlay-extension', repair, /published size and digest/);
      expect(await readFile(ledgerPath, 'utf8')).toBe(damagedLedger);
      artifacts.set(firstRelease.artifact.url, firstBody);
      expect(await cli('repair-overlay-extension', repair)).toEqual({ packageId: first.packageId, status: 'repaired' });
      const repaired = (await cli('list-overlay-extensions'))[0];
      expect(repaired).toMatchObject({
        id: first.packageId,
        releaseId: first.releaseId,
        enabled: false,
        visible: false,
      });
      expect(repaired.fileIssue).toBeUndefined();
      const repairedLedger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      expect(repairedLedger.packages[0].panel).toEqual(intactPanel);
      expect((await cli('game-status')).session.sessionId).toBe(session.sessionId);

      const replacement = publish(
        first.packageId,
        'revised',
        'Guide 0',
        Buffer.from(JSON.stringify({ schemaVersion: 1, title: 'Revised guide', text: 'Replacement' })),
        { kind: 'overlay-panel', launcherRange: '^0.1.0' },
      );
      releases.get(`${replacement.packageId}/${replacement.releaseId}`)!.version = first.releaseId;
      const recordedDownloads = downloads.length;
      const replacementPlan = await cli('preview-rezics-package', replacement);
      expect(replacementPlan.changes).toMatchObject([
        { releaseId: 'revised', action: 'replace', installedVersion: first.releaseId, enables: true },
      ]);
      expect((await host.core.listInstalled())[0]).toMatchObject({ releaseId: first.releaseId, enabled: false });
      expect(downloads).toHaveLength(recordedDownloads);
      await cli('install-rezics-package', replacementPlan);
      expect((await host.core.listInstalled())[0]).toMatchObject({
        version: first.releaseId,
        releaseId: replacement.releaseId,
        enabled: true,
      });
      expect((await cli('game-status')).session.panels[0]).toMatchObject({ title: 'Revised guide' });

      const left = await host.core.createMinecraft({ name: 'Compatible Fabric', loader: 'fabric' });
      const right = await host.core.createMinecraft({ name: 'Other Fabric', loader: 'fabric' });
      await cli('preview-rezics-package', mod, /incompatible/);
      const reviewedMod = await cli('preview-rezics-package', { ...mod, instanceId: left.id });
      await cli('install-rezics-package', { ...reviewedMod, instanceId: right.id }, /Preview the installation again/);
      await cli('install-rezics-package', reviewedMod);
      const mods = join(dataDir, 'instances', left.id, 'game', 'mods');
      const [file] = await readdir(mods);
      expect(await readFile(join(mods, file!))).toEqual(jar);
      expect(await host.core.listInstalled(right.id)).toEqual([]);
      expect(modEvents).toEqual([left.id]);
    } finally {
      const session = await host?.core.currentSession();
      if (session) await host?.core.stopGame(session.sessionId).catch(() => {});
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
