import type { LauncherApi } from '@rezics/launcher-contract';
import type { PluginRpcHandlers } from '../rpc-types';
import { text } from '../rpc-values';

type LaunchDiagnosticsPort = Pick<LauncherApi, 'readLaunchReport' | 'launchDiagnosticText'>;

export function launchDiagnosticsDesktop(
  core: LaunchDiagnosticsPort,
  copyText: (text: string) => void,
): PluginRpcHandlers<'launch-diagnostics'> {
  return {
    readLaunchReport: (id) => core.readLaunchReport(text(id)),
    async copyLaunchDiagnostic(id) {
      const diagnostic = await core.launchDiagnosticText(text(id));
      if (diagnostic === null) return false;
      copyText(diagnostic);
      return true;
    },
  };
}
