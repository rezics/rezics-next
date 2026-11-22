import type { Launcher } from '@rezics/launcher-core';
import type { PluginAutomationHandlers } from '../automation-types';
import { text } from '../rpc-values';

export const launchDiagnosticsCommands = {
  'launch-log': {
    run: async (core, id) => ({ value: await core.launchDiagnosticText(text(id)) }),
  },
  'launch-report': {
    async run(core, id) {
      const report = await core.readLaunchReport(text(id));
      if (!report) return { value: null };
      const { state, exitCode, signal, issue, crashReport } = report;
      return {
        value: {
          state,
          exitCode,
          signal,
          issue: issue ? { kind: issue.kind, action: issue.action } : null,
          ...(crashReport && { crashReport: { truncated: crashReport.truncated } }),
        },
      };
    },
  },
} satisfies PluginAutomationHandlers<'launch-diagnostics', Pick<Launcher, 'launchDiagnosticText' | 'readLaunchReport'>>;
