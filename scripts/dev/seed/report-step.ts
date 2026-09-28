import { communityPeople, communityRealms } from './community-plan.ts';
import { people, realms, works } from './plan.ts';
import type { SeedState } from './state.ts';

export async function printSeedReport(state: SeedState) {
  const { created, createdRealms, seededZones, agentCount, publishedCount, selectedCount,
    commentCount, replyCount, reviewCount, endpoints, findings } = state;
  if (createdRealms.length !== realms.length || seededZones.length !== realms.length) {
    findings.add('The planned Realms or official Zones were not all created');
  }
  if (state.communityRealms.size !== communityRealms.length) findings.add('The community Realms were not all created');
  const accounts = [...people, ...communityPeople];
  console.log(`\nSeeded ${created.size} Works, ${createdRealms.length + state.communityRealms.size} Realms (${seededZones.length} official Zones, ${state.communityRealms.size} community), ${accounts.length} Account users, ${agentCount} Agents, ${publishedCount} published contributions, ${selectedCount} Main selections, ${commentCount} comments and discussions, ${replyCount} replies, ${reviewCount} reviews.`);
  console.log('Demo sign-in credentials:');
  for (const person of accounts) console.log(`  ${person.name}: ${person.email} / ${person.password}`);
  console.log('Search URLs:');
  for (const id of ['pride', 'journey-west', 'dumplings']) {
    const work = works.find(item => item.id === id)!;
    const receipt = created.get(id)!;
    console.log(`  http://localhost:3000/works/${receipt.workRevision.split('/').at(-1)}`);
    console.log(`  http://localhost:3000/search?q=${encodeURIComponent(work.title)}`);
  }
  for (const realm of createdRealms) console.log(`  Realm API: ${endpoints.main}/v1/spaces/${realm.receipt.space.split('/').at(-1)}`);
  if (findings.size) {
    console.log('Public API gaps or unavailable outcomes:');
    for (const finding of findings) console.log(`  ${finding}`);
  }
}
