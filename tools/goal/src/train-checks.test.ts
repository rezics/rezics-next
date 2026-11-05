import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAffectedTest, runIntegrationChecks } from './train-checks.ts';
import { temporaryDirectory } from './test-support.ts';

test('owned check adapters preserve argv, actual cwd, environment and command log sections', async () => {
  const directory = temporaryDirectory();
  try {
    const affectedLog = join(directory.path, 'affected.log');
    const affectedCommand = [
      'sh',
      '-c',
      'printf "%s|%s|%s" "$PWD" "$TRAIN_CHECK_FIXTURE" "$1"',
      'fixture',
      'affected-arg',
    ];
    const affected = await runAffectedTest(affectedCommand, directory.path, affectedLog, {
      ...process.env,
      TRAIN_CHECK_FIXTURE: 'affected-env',
    });
    expect(affected.status).toBe('passed');
    expect(affected.output).toContain(`${directory.path}|affected-env|affected-arg`);
    expect(readFileSync(affectedLog, 'utf8')).toContain(
      `$ ${affectedCommand.join(' ')} (cwd: ${directory.path})`,
    );

    const integrationLog = join(directory.path, 'integration.log');
    const integrationCommand = ['sh', '-c', 'printf "%s|%s" "$PWD" "$1"', 'fixture', 'integration-arg'];
    const integration = await runIntegrationChecks([integrationCommand], directory.path, integrationLog);
    expect(integration.passed).toBe(true);
    expect(integration.output).toContain(`${directory.path}|integration-arg`);
    expect(readFileSync(integrationLog, 'utf8')).toContain(
      `$ ${integrationCommand.join(' ')} (cwd: ${directory.path})`,
    );
  } finally {
    directory.close();
  }
});
