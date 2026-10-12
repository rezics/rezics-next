import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import {
  assertZoneGrowthProfiles,
  withZoneGrowthTelemetry,
  ZONE_GROWTH_COVERAGE,
  measuredCounters,
  measureZoneSite,
  profileDump,
  restoreZoneCuts,
  routePathFor,
  type ScaledProfile,
  wiringProbe,
  writeProfileDump,
} from '../support/zone-navigation-growth.ts';

test.todo('Zone route and presentation unrelatedWorks: NOT COVERED until kernel class B supplies fixed own entries at 4/16/64 unrelated Works');
test.todo('Zone reads unrelatedPosts: NOT COVERED until kernel class B supplies 4/16/64 unrelated Posts');

test('Zone census stays constant and site reads obey absolute caps across retained cuts', async () => {
  await withZoneGrowthTelemetry(async sink => {
    const { readRetainedSeed } = await import('../support/seed-checkpoints.ts');
    const { ZONE_ROUTE_COST } = await import('../../../services/main/src/modules/zone/route-cost.ts');
    const retained = readRetainedSeed();
    expect(retained.cuts.map((cut) => cut.manifest.dimensions.unrelatedWorks)).toEqual([4, 16, 64]);
    const qaRunId = Bun.env.REZICS_QA_RUN_ID;
    if (!qaRunId) throw new Error('Zone navigation growth requires task goal QA run metadata');
    const qaStackDir = join(root, '.temp', 'stack', 'rezics-qa-' + qaRunId);
    expect(readEnv(join(qaStackDir, 'compose.env')).REZICS_STACK_STORAGE).toBe('persistent');
    const artifactDirectory = Bun.env.REZICS_QA_ARTIFACT_DIR;
    if (!artifactDirectory) throw new Error('Zone growth coverage needs REZICS_QA_ARTIFACT_DIR');
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, 'zone-growth-coverage.json'), JSON.stringify(ZONE_GROWTH_COVERAGE, null, 2) + '\n');
    const profiles: Record<'census' | 'route' | 'presentation', ScaledProfile[]> = {
      census: [], route: [], presentation: [],
    };
    await restoreZoneCuts({
      sink,
      censusProfiles: profiles.census,
      qaRunId,
      retained,
      label: 'zone-navigation',
      cuts: retained.cuts,
      measure: async (cut, restored) => {
        const scale = cut.manifest.dimensions.unrelatedWorks;
        const segment = cut.population.zone.mounts[0]!.segment;
        if (cut.manifest.scale === 'small')
          await wiringProbe(sink, restored, routePathFor(cut.population.zone.id, segment), scale, cut.manifest.scale);
        const { routePath, presentationPath, route, presentation } = await measureZoneSite(
          sink, restored, cut.population.zone.id, segment, scale,
        );

        const routePage = route.result as {
          kind: string;
          items: Array<{ id: string; inZone: boolean }>;
        };
        expect(routePage.kind).toBe('index');
        expect(routePage.items.map((item) => ({ id: item.id, inZone: item.inZone }))).toEqual(
          cut.population.collection.members.slice(0, 24).map((member) => ({
            id: member.work,
            inZone: true,
          })),
        );

        const zonePresentation = presentation.result as {
          navigationComplete: boolean;
          navigationNext: string | null;
          navigation: Array<{ segment: string; target: string; kind: string }>;
        };
        expect(zonePresentation.navigationComplete).toBe(true);
        expect(zonePresentation.navigationNext).toBeNull();
        expect(zonePresentation.navigation).toHaveLength(cut.manifest.dimensions.zoneNavigationEntries!);
        expect(zonePresentation.navigation.map(({ segment: itemSegment, target: itemTarget, kind }) => ({
          segment: itemSegment,
          target: itemTarget,
          kind,
        }))).toEqual(cut.population.zone.mounts.map((mount) => ({
          segment: mount.segment,
          target: mount.target,
          kind: 'index',
        })));

        writeProfileDump('zone-route-profile-' + cut.manifest.scale,
          profileDump('route', cut.manifest.scale, routePath, route.profile, restored.apps));
        writeProfileDump('zone-presentation-profile-' + cut.manifest.scale,
          profileDump('presentation', cut.manifest.scale, presentationPath, presentation.profile, restored.apps));
        profiles.route.push(route.profile);
        profiles.presentation.push(presentation.profile);
        console.log('Zone navigation checkpoint counters', JSON.stringify({
          scale: cut.manifest.scale,
          dimensions: {
            unrelatedWorks: cut.manifest.dimensions.unrelatedWorks,
            recipeOccurrences: cut.manifest.dimensions.recipeOccurrences,
            zoneNavigationEntries: cut.manifest.dimensions.zoneNavigationEntries,
            mountedCollectionResources: cut.manifest.dimensions.mountedCollectionResources,
            readerShelfEntries: cut.manifest.dimensions.readerShelfEntries,
          },
          routes: measuredCounters(route.profile),
          presentation: measuredCounters(presentation.profile),
        }));
      },
    });

    assertZoneGrowthProfiles(profiles, ZONE_ROUTE_COST);
  });
}, 600_000);
