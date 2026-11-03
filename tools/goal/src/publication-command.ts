import { authenticatedManager } from './priority-authority.ts';
import { PublicationController } from './publication.ts';
import type { IntegrationRuntime } from './integration-cli.ts';
import type { Runtime } from './config.ts';

type CommandRuntime = IntegrationRuntime &
  Pick<Runtime, 'settings' | 'inbox'> & {
    publicationController?: PublicationController;
  };

function configuredController(runtime: CommandRuntime): PublicationController {
  if (runtime.publicationController) return runtime.publicationController;
  const operationsManager = runtime.settings.integration.operationsManager;
  if (!operationsManager || operationsManager.trim() !== operationsManager)
    throw new Error('publication ingress requires a configured integration.operationsManager');
  return new PublicationController({
    policy: runtime.settings.policy,
    db: runtime.db,
    mainCheckout: runtime.mainCheckout,
    stateDirectory: runtime.stateDirectory,
    worktreeRoot: runtime.worktreeRoot,
    integrationBranch: runtime.settings.integrationBranch,
    operationsManager,
    inbox: runtime.inbox,
  });
}

function positiveId(value: string | undefined, name: string): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`publication ${name} must be a positive integer`);
  return Number(value);
}

function statusCode(status: Record<string, unknown>): number {
  const state = status.state;
  const delivery = status.delivery;
  if (state === 'terminal-success')
    return delivery && typeof delivery === 'object' && (delivery as { state?: unknown }).state === 'delivered' ? 0 : 1;
  if (state === 'terminal-non-green' || state === 'preparation-failed' || state === 'unknown') return 1;
  const receipt = status.terminalReceipt;
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt))
    return (receipt as { success?: unknown }).success === true ? 0 : 1;
  return 0;
}

export async function runPublicationCommand(args: string[], runtime: CommandRuntime): Promise<number> {
  const [subcommand, first, second] = args;
  if (!subcommand)
    throw new Error(
      'usage: goal publication <receive|legacy-receive|legacy-prepare|legacy-status|legacy-resolve|bootstrap|capture-register|capture-retire|start|status|recover>',
    );
  if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
    throw new Error('worker sessions cannot receive or operate native publication custody');
  const operationsManager = runtime.settings.integration.operationsManager;
  if (!operationsManager) throw new Error('publication ingress requires a configured integration.operationsManager');
  const actor = authenticatedManager(runtime.db, process.env);
  if (!actor) throw new Error('publication commands require a current authenticated manager provider session');
  if (actor.id !== operationsManager)
    throw new Error(`publication commands require configured operations manager ${operationsManager}`);
  const controller = configuredController(runtime);

  if (subcommand === 'legacy-receive' || subcommand === 'legacy-resolve') {
    if (!first || second || args.length !== 2)
      throw new Error(`usage: goal publication ${subcommand} <owner-inbox-message-id>`);
    const messageId = positiveId(first, 'owner inbox message id');
    const receipt =
      subcommand === 'legacy-receive'
        ? controller.legacy.receive(messageId, actor)
        : controller.legacy.resolve(messageId, actor);
    console.log(JSON.stringify(receipt));
    return receipt.state === 'unavailable' ? 1 : 0;
  }
  if (subcommand === 'legacy-prepare') {
    if (second || args.length > 2)
      throw new Error('usage: goal publication legacy-prepare [native-inventory-inbox-message-id]');
    console.log(
      JSON.stringify(
        controller.legacy.prepare(actor, first ? positiveId(first, 'native inventory inbox message id') : undefined),
      ),
    );
    return 1;
  }
  if (subcommand === 'legacy-status') {
    if (second || args.length > 2)
      throw new Error('usage: goal publication legacy-status [inbox-message-or-preparation-id]');
    console.log(JSON.stringify(controller.legacy.status(first)));
    return 0;
  }

  if (subcommand === 'receive') {
    if (second || args.length !== 2) throw new Error('usage: goal publication receive <owner-inbox-message-id>');
    console.log(JSON.stringify(controller.receive(positiveId(first, 'owner inbox message id'), actor)));
    return 0;
  }
  if (subcommand === 'bootstrap') {
    if (first || second || args.length !== 1) throw new Error('usage: goal publication bootstrap');
    console.log(JSON.stringify(controller.bootstrap(actor)));
    return 0;
  }
  if (subcommand === 'capture-register') {
    if (!first || !second || args.length !== 3)
      throw new Error('usage: goal publication capture-register <pid> <retained-registration-evidence-path>');
    const pid = positiveId(first, 'capture PID');
    console.log(JSON.stringify(controller.registerCapture(actor, pid, second)));
    return 0;
  }
  if (subcommand === 'capture-retire') {
    if (!first || !second || args.length !== 3)
      throw new Error('usage: goal publication capture-retire <custody-id> <terminal-evidence-path>');
    console.log(JSON.stringify(controller.retireCapture(actor, first, second)));
    return 0;
  }
  if (subcommand === 'start') {
    if (!first || second || args.length !== 2) throw new Error('usage: goal publication start <received-authority-id>');
    const status = await controller.start(first, actor);
    console.log(JSON.stringify(status));
    return statusCode(status);
  }
  if (subcommand === 'status') {
    if (second || args.length > 2) throw new Error('usage: goal publication status [authority-or-invocation-id]');
    const status = controller.status(first);
    console.log(JSON.stringify(status));
    return 0;
  }
  if (subcommand === 'recover') {
    if (!first || second || args.length !== 2)
      throw new Error('usage: goal publication recover <original-invocation-id>');
    const status = await controller.recover(first, actor);
    console.log(JSON.stringify(status));
    return statusCode(status);
  }
  throw new Error(`unknown publication subcommand: ${subcommand}`);
}
