import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentDisclosureDriver } from '../../../../../specs/content-disclosure-driver';
import type { ContentMediaDriver } from '../../../../../specs/content-media-driver';
import type { ContentThreadDriver } from '../../../../../specs/content-thread-driver';
import { createContentSystem } from './system.ts';
import { observeSql } from './sql-observer.ts';
import type { ContentSystem } from './system.ts';

function threadConsumer(system: ContentSystem, driver: ContentThreadDriver): void {
  void system.kernel.handle;
  void system.actors.author;
  void driver.create;
  void driver.commandTrace;
}

function disclosureConsumer(system: ContentSystem, driver: ContentDisclosureDriver): void {
  void system.kernel.handle;
  void system.actors.suspended;
  void driver.replayCommand;
  void driver.projection;
}

function mediaConsumer(system: ContentSystem, driver: ContentMediaDriver): void {
  void system.kernel.handle;
  void system.actors.worker;
  void driver.authenticationEvidence;
  void driver.raceClaimCollection;
}

void [threadConsumer, disclosureConsumer, mediaConsumer];

describe('content support contracts', () => {
  test('unfinished factories fail before opening external resources', () => {
    expect(() => createContentSystem({ databaseUrl: 'postgres://unused.invalid/content' })).toThrow(
      'createContentSystem is not implemented',
    );
    expect(() => observeSql({} as Pool)).toThrow('observeSql is not implemented');
  });
});
