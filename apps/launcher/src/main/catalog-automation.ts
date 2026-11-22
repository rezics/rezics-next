import type { RegisteredAutomationHandler } from './automation-types';
import {
  catalogKind,
  optionalText,
  overlayPackageIds,
  packageEnabled,
  record,
  releaseReference,
  reviewRevision,
  text,
} from './rpc-values';

export const catalogCommands = {
  'search-rezics-packages': {
    input: 'json',
    async run(core, argument) {
      const { kind, query, cursor } = record(argument);
      return {
        value: await core.listPackages(catalogKind(kind), optionalText(query, 120), optionalText(cursor, 4096)),
      };
    },
  },
  'rezics-package-releases': {
    input: 'json',
    async run(core, argument) {
      const { packageId, cursor } = record(argument);
      return { value: await core.listReleases(text(packageId), optionalText(cursor, 4096)) };
    },
  },
  'preview-rezics-package': {
    input: 'json',
    async run(core, argument, signal) {
      const fields = record(argument);
      return {
        value: await core.previewCatalogInstall(releaseReference(fields), optionalText(fields.instanceId), signal),
      };
    },
  },
  'install-rezics-package': {
    input: 'json',
    async run(core, argument, signal) {
      const fields = record(argument);
      const release = releaseReference(fields);
      const instanceId = optionalText(fields.instanceId);
      const revision = reviewRevision(fields.revision, 'package installation');
      await core.installReviewedCatalogPackage(release, { revision, ...(signal && { signal }) }, instanceId);
      const value = { ...release, instanceId, status: 'installed' };
      return instanceId ? { value, modFolderChanged: instanceId } : { value, extensionsChanged: true };
    },
  },
  'list-overlay-extensions': {
    input: 'none',
    run: async (core) => ({ value: await core.listOverlayExtensions() }),
  },
  'reorder-overlay-extensions': {
    input: 'json',
    description: 'Save a reviewed display order for the installed Overlay extensions.',
    async run(core, argument) {
      const { packageIds, orderRevision } = record(argument);
      const ids = overlayPackageIds(packageIds);
      await core.reorderOverlayExtensions(ids, reviewRevision(orderRevision, 'Overlay extension order'));
      return { value: { packageIds: ids, status: 'applied' }, extensionsChanged: true };
    },
  },
  'repair-overlay-extension': {
    input: 'json',
    async run(core, argument, signal) {
      const fields = record(argument);
      const packageId = text(fields.packageId);
      await core.repairOverlayExtension(
        packageId,
        reviewRevision(fields.revision, 'installed Overlay extension'),
        signal,
      );
      return { value: { packageId, status: 'repaired' }, extensionsChanged: true };
    },
  },
  'set-overlay-extension-enabled': {
    input: 'json',
    async run(core, argument) {
      const fields = record(argument);
      const packageId = text(fields.packageId);
      const enabled = packageEnabled(fields.enabled);
      await core.changeOverlayExtension(
        packageId,
        reviewRevision(fields.revision, 'installed Overlay extension'),
        enabled,
      );
      return { value: { packageId, enabled }, extensionsChanged: true };
    },
  },
  'uninstall-overlay-extension': {
    input: 'json',
    async run(core, argument) {
      const fields = record(argument);
      const packageId = text(fields.packageId);
      await core.changeOverlayExtension(
        packageId,
        reviewRevision(fields.revision, 'installed Overlay extension'),
        null,
      );
      return { value: { packageId, status: 'uninstalled' }, extensionsChanged: true };
    },
  },
} satisfies Record<string, RegisteredAutomationHandler>;
