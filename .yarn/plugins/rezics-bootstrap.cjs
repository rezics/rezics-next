'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');

function runStep(command, args, cwd = root, spawn = spawnSync) {
  const result = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} ${args.join(' ')} stopped by ${result.signal}`);
  return result.status ?? 1;
}

function installToolchain(cwd = root, spawn = spawnSync) {
  const installStatus = runStep('corepack', ['yarn', 'install', '--immutable'], cwd, spawn);
  if (installStatus !== 0) return installStatus;
  return runStep('bun', ['scripts/dev/cli.ts', 'toolchain:install'], cwd, spawn);
}

module.exports = {
  name: 'rezics-bootstrap',
  factory: require => {
    const { BaseCommand } = require('@yarnpkg/cli');
    class ToolchainInstallCommand extends BaseCommand {
      static paths = [['toolchain:install']];

      async execute() {
        return installToolchain();
      }
    }
    return { commands: [ToolchainInstallCommand] };
  },
  // A pure command runner lets the unit test check ordering without installing images.
  installToolchain,
};
