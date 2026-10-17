import { Pool } from 'pg';
import { applyAnimeMangaZones } from './anime-manga-zones-step.ts';
import { createSpace } from './ln-vn-zones-step.ts';
import { adoptZoneSpace } from './realms-step.ts';
import { grantOfficialZoneSeed, type LocalOperatorInput } from './operator.ts';
import { refreshSeedTokens, stableId, type SeedState } from './state.ts';
import { grantVnSeedAuthority, seedHttp, type SeedPort } from './vn-catalogue-step.ts';

/** Official catalogue setup exceeds one member's monthly Space allowance.
 * Keep ordinary member quota intact and use explicit operator delegation.
 * Adopt earlier member-created Zones before changing the issuing principal. */
export async function createCatalogueSpace(port: SeedPort, spec: Parameters<typeof createSpace>[1], zone: string) {
  if (!port.spaceRequest) return createSpace(port, spec, zone);
  const retained = await adoptZoneSpace(async path => {
    const result = await port.request('GET', path);
    if (result.status === 404) return null;
    if (result.status !== 200) throw new Error(`Catalogue Space read HTTP ${result.status}`);
    return result.body as Record<string, unknown>;
  }, zone, port.actingSubject);
  return retained ?? createSpace({ ...port, request: port.spaceRequest }, spec, zone);
}

/** Local authority and Account setup stay outside the catalogue mapping plan. */
export async function seedAnimeMangaZones(state: SeedState): Promise<void> {
  const session = state.sessions[0];
  if (!session || !state.operatorInput || !state.operatorSession)
    throw new Error('Anime and manga Zones need the operator session');
  const input: LocalOperatorInput = { ...state.operatorInput, ownerAccountSubject: session.accountId,
    actingSubject: session.actingSubject };
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const memberRequest: SeedPort['request'] = (method,path,body,key) => seedHttp(state,()=>session.token,method,path,body,key);
  const operatorRequest: SeedPort['request'] = async (method,path,body,key) => {
    const token = await state.api.token(state.operatorSession!.cookie);
    return seedHttp(state,()=>token,method,path,body,key);
  };
  try {
    const port: SeedPort = {
      actingSubject: session.actingSubject,
      request: async (method,path,body,key) => {
        if (method !== 'POST' || path !== '/v1/spaces') return memberRequest(method,path,body,key);
        const spec = body as { name:string; handle:string };
        if (!['anime','manga'].includes(spec.handle)) throw new Error('Unexpected catalogue Space');
        const zone = `https://rezics.com/id/${stableId(`zone:${spec.handle}`)}`;
        await grantVnSeedAuthority(pool,input,`zone:edit:${zone}`,'zone.edit');
        await grantVnSeedAuthority(pool,input,`semantic:read:${zone}`,'semantic.read');
        const receipt = await createCatalogueSpace({ ...port, request:memberRequest, spaceRequest:operatorRequest },
          { id:spec.handle,name:spec.name,language:'en',routeSegment:spec.handle,preset:'editorial',
            mountSegment:'catalogue',navigation:[],browse:[],announcement:'',sharedMember:'' }, zone);
        return { status:200,body:receipt };
      },
      officialRequest:(method,path,body,key)=>seedHttp(state,()=>state.operatorSession!.token,method,path,body,key),
      grant: async (scope,action) => {
        if (action === 'space.create') await grantVnSeedAuthority(pool,
          { ...input,ownerAccountSubject:input.accountSubject },scope,action);
        if (action === 'zone.official') { await grantOfficialZoneSeed(input,scope.slice('zone:official:'.length)); return; }
        await grantVnSeedAuthority(pool,input,scope,action);
      },
      refresh:()=>refreshSeedTokens(state),
    };
    const created = await applyAnimeMangaZones(port);
    state.catalogueZones=created.zones.map(zone=>zone.id);
    console.log(`Anime and manga: ${created.works.length} works in ${created.zones.map(zone=>zone.id).join(', ')}`);
  } finally { await pool.end(); }
}
