import { expect, test } from 'bun:test';
import { softwareCatalogue } from './software-catalogue.ts';
import { extraWorks, zoneContent } from './official-plan.ts';

test('Software seeds ten open-source app Works with source, handoff and attributable alternatives', () => {
  expect(softwareCatalogue).toHaveLength(10);
  const ids = new Set(softwareCatalogue.map(app => app.id));
  expect(ids.size).toBe(10);
  expect(zoneContent.software.adopt).toEqual(softwareCatalogue.map(app => app.id));
  for (const app of softwareCatalogue) {
    expect(app.project).toMatch(/^https:\/\//);
    expect(app.source).toMatch(/^https:\/\//);
    expect(app.license.length).toBeGreaterThan(0);
    expect(app.platforms.length).toBeGreaterThan(0);
    expect(extraWorks.find(work => work.id === app.id)).toMatchObject({ realm: 'software', type: 'software' });
    for (const alternative of app.alternatives) {
      expect(ids).toContain(alternative.id);
      expect(alternative.reason.length).toBeGreaterThan(12);
    }
  }
});
