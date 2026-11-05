import type { CheckResults } from './check-results.ts';
import {
  gateRunner,
  processGroupRunner,
  type CheckResultGateOptions,
  type GateRunner,
} from './merge.ts';
import {
  trainConfigurationRevision,
  type IntegrationCheck,
  type TrainConfigurationReloader,
} from './merge-train.ts';
import { loadSettings, packageDerivedFiles } from './settings.ts';
import type { DerivedFile, Settings } from './types.ts';
import { bootSmokeEnvironment } from './verification.ts';
import { defaultPolicy } from './policy.ts';

export const LANDING_CHECK_ENVIRONMENT = { REMOTE_CHECK_PRIORITY: 'landing' } as const;

export type CheckRuntimeOptions = {
  settings: Settings;
  results: CheckResults;
  derivedFiles?: DerivedFile[];
  runGate?: GateRunner;
  deliverReuseAlert(managerId: string, summary: string): void;
};

function createTrainCheckRunners(
  settings: Settings,
  runGateOverride: GateRunner | undefined,
  checkResultOptions: CheckResultGateOptions,
) {
  return {
    runGate:
      runGateOverride ??
      gateRunner(
        settings.integration.gateTimeoutMs,
        settings.stateDirectory,
        LANDING_CHECK_ENVIRONMENT,
        checkResultOptions,
        settings.policy?.merge,
      ),
    runTypecheck: processGroupRunner(
      settings.integration.gateTimeoutMs,
      settings.stateDirectory,
      process.env,
      true,
      settings.policy?.merge,
    ),
    runControlPlaneGate:
      runGateOverride ??
      gateRunner(
        settings.integration.gateTimeoutMs,
        settings.stateDirectory,
        LANDING_CHECK_ENVIRONMENT,
        undefined,
        settings.policy?.merge,
      ),
  };
}

export function createCheckRuntime(options: CheckRuntimeOptions) {
  const { settings } = options;
  const checkResultOptions = {
    root: settings.mainCheckout,
    results: options.results,
    shadow: !settings.integration.checkResultReuse,
    enabled: settings.integration.checkResultReuse,
    alert: (summary: string) =>
      options.deliverReuseAlert(
        settings.integration.supermanager,
        `Check result reuse alert: ${summary}`,
      ),
  };
  const trainRunners = createTrainCheckRunners(settings, options.runGate, checkResultOptions);
  const runGate = trainRunners.runGate;
  // Promotion runs the full root gate, which outlasts the integration gate's limit.
  const promotionGate: GateRunner =
    options.runGate ??
    gateRunner(
      Math.max(settings.integration.gateTimeoutMs, (settings.policy ?? defaultPolicy).promotion.gateTimeoutMs),
      settings.stateDirectory,
      {},
      checkResultOptions,
      settings.policy?.merge,
    );
  // Verifier checks run at ordinary priority and retain their derived state-directory choice.
  const verifierGate: GateRunner =
    options.runGate ??
    gateRunner(
      Math.max(settings.integration.gateTimeoutMs, (settings.policy ?? defaultPolicy).verifier.gateTimeoutMs),
      undefined,
      {},
      checkResultOptions,
      settings.policy?.merge,
    );
  // Boot smoke is local and bounded; it uses neither remote-check nor worker-slot admission.
  const bootSmokeGate: GateRunner =
    options.runGate ??
    processGroupRunner(
      (settings.policy ?? defaultPolicy).verifier.bootSmokeTimeoutMs,
      undefined,
      bootSmokeEnvironment(),
      false,
      settings.policy?.merge,
    );
  // The compiler is the existing direct process group, separate from injected gate runners.
  const typecheckGate = trainRunners.runTypecheck;
  const runControlPlaneGate = trainRunners.runControlPlaneGate;

  const refreshTrainConfiguration: TrainConfigurationReloader = () => {
    const latest = loadSettings({ cwd: settings.mainCheckout, localFile: settings.localFile });
    const refreshedRunners = createTrainCheckRunners(latest, options.runGate, checkResultOptions);
    const configuration = {
      policy: latest.policy,
      integration: latest.integration,
      formatCommand: latest.formatCommand,
      affectedTests: latest.affectedTests ?? [],
      integrationChecks: latest.integrationChecks,
      derivedFiles: options.derivedFiles ?? latest.derivedFiles ?? packageDerivedFiles,
      gateIdentity: JSON.stringify(latest.gate),
      mainBranch: latest.mainBranch,
      integrationBranch: latest.integrationBranch,
      stabilizeBranch: latest.stabilizeBranch,
      supermanager: latest.integration.supermanager,
      inboxDirectory: latest.integration.inboxDirectory,
      ...refreshedRunners,
    };
    return { ...configuration, configurationRevision: trainConfigurationRevision(configuration) };
  };

  return {
    runGate,
    promotionGate,
    verifierGate,
    bootSmokeGate,
    typecheckGate,
    runControlPlaneGate,
    refreshTrainConfiguration,
  };
}
