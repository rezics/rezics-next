import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { assertWorkCostAtScales, startWorkProfileSink } from '../support/work-profile.ts';
import {
  logWorkCostRatios,
  measuredCounters,
  measureZoneSite,
  profileDump,
  restoreZoneCuts,
  routePathFor,
  type ScaledProfile,
  wiringProbe,
  writeProfileDump,
  zoneSiteReadCost,
} from '../support/zone-navigation-growth.ts';

test('Zone navigation reads stay within their cost class as unrelated Works grow', async () => {
  const sink = startWorkProfileSink();
  // pg must load after the SDK installs its instrumentation hooks.
  startTelemetry('main', {
    ...process.env,
    ...sink.env,
    OTEL_SERVICE_NAME: 'main',
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  const { readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { ZONE_ROUTE_COST } = await import('../../../services/main/src/modules/zone/route-cost.ts');
  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions.unrelatedWorks)).toEqual([4, 16, 64]);

  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Zone navigation growth requires task goal QA run metadata');

  const qaStackDir = join(root, '.temp', 'stack', 'rezics-qa-' + qaRunId);
  expect(readEnv(join(qaStackDir, 'compose.env')).REZICS_STACK_STORAGE).toBe('persistent');

  const presentationProfiles: ScaledProfile[] = [];
  try {
    await restoreZoneCuts({
      sink,
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
        if (cut.manifest.scale === 'large') {
          // Own entries: the route pages at most pageSize items and stays within the Zone site's graph caps.
          expect(routePage.items).toHaveLength(
            Math.min(cut.manifest.dimensions.zoneNavigationEntries!, ZONE_ROUTE_COST.pageSize),
          );
          expect(route.profile.fusekiRequests).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphReads);
          expect(route.profile.fusekiSentBytes).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphBytes);
          expect(route.profile.fusekiReceivedBytes).toBeLessThanOrEqual(ZONE_ROUTE_COST.maxGraphBytes);
        }

        const zonePresentation = presentation.result as {
          navigation: Array<{ segment: string; target: string; kind: string }>;
        };
        expect(zonePresentation.navigation.map(({ segment: itemSegment, target: itemTarget, kind }) => ({
          segment: itemSegment,
          target: itemTarget,
          kind,
        }))).toEqual(cut.population.zone.mounts.slice(0, ZONE_ROUTE_COST.maxNavigation).map((mount) => ({
          segment: mount.segment,
          target: mount.target,
          kind: 'index',
        })));

        writeProfileDump('zone-route-profile-' + cut.manifest.scale,
          profileDump('route', cut.manifest.scale, routePath, route.profile, restored.apps));
        writeProfileDump('zone-presentation-profile-' + cut.manifest.scale,
          profileDump('presentation', cut.manifest.scale, presentationPath, presentation.profile, restored.apps));
        presentationProfiles.push(presentation.profile);
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

    const cost = zoneSiteReadCost(ZONE_ROUTE_COST);
    logWorkCostRatios('zone-presentation-growth', presentationProfiles, cost);
    assertWorkCostAtScales(presentationProfiles, cost, 'zone-presentation-growth');
  } finally {
    await shutdownTelemetry();
    await sink.stop();
  }
}, 600_000);
