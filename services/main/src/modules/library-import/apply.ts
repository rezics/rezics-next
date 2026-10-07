import { ImportCommands, importReviewedBatch, portableShelfId, type ReviewedImportBatch } from './batch.ts';
import { LibraryFileStore, importDigest, type ApplyIntent, type StoredSourceRow } from './file-store.ts';
import type { ReaderLibraryImportStore } from './reader-import.ts';
import { requireImportOwnerAvailable } from './reader-import.ts';
import { mainCall } from './match.ts';
import type { CanonicalRow, LibraryFileFormat } from './formats/contract.ts';
import type { SessionState } from '../session/contract.ts';
import { bindImportSession, findImportSession, importSessionMatches, ImportSessionFailed, readSessionImportState } from './session-import.ts';

/** Only identical scales (including quantization) enter the standing rating
 * Context. StoryGraph quarter stars and VNDB tenths remain source evidence. */
export function globalImportRating(row: CanonicalRow): number | null {
  const score = row.score;
  return score && score.min === 1 && score.max === 5 && score.step === 1
    && Number.isInteger(score.value) && score.value >= 1 && score.value <= 5 ? score.value : null;
}
const day = (value: string | null) => value?.length === 10 ? value : null;
const uuid = (iri: string) => iri.slice(-36);
const commandKey = (agent: string, file: string, index: number, step: string) =>
  `file-import:${importDigest([agent,file,index,step]).slice(0,48)}`;
async function sessionStep(store: ReaderLibraryImportStore, request: Request, agent: string, file: string,
  row: number, step: string, method: string, path: string, body: object): Promise<SessionState | null> {
  const key = commandKey(agent,file,row,step);
  const held = await store.planStep(agent,file,row,step,{ method,path,body,key });
  const plan = held.plan as { method: string; path: string; body: object; key: string };
  const response = await mainCall(store,request,plan.method,plan.path,plan.body,plan.key);
  requireImportOwnerAvailable(response);
  if (response.status === 202) return null;
  if (!response.ok) throw new ImportSessionFailed('Session import command was refused');
  await store.completeStep(agent,file,row,step);
  return response.json() as Promise<SessionState>;
}

async function applyRow(store: ReaderLibraryImportStore, request: Request, agent: string,
  fileKey: string, item: StoredSourceRow, intent: ApplyIntent, format: LibraryFileFormat): Promise<NonNullable<StoredSourceRow['outcome']> | null> {
  const row = item.source, choice = item.resolution;
  if (choice?.choice === 'private' || row.kind === 'retained') return { applied: ['private-source'], issues: [] };
  const work = choice?.work ?? item.match?.work ?? row.work;
  if (row.kind === 'shelf') {
    // Empty shelves are library state too. Ordinary collection writes own their disclosure.
    const name = row.shelves[0] ?? row.title;
    const collection = portableShelfId(agent,row.sourceId);
    const response = await mainCall(store,request,'POST','/v1/collections', { actingSubject: agent,
      collection, name, disclosure: row.raw.disclosure === 'public' ? 'public' : 'private' },
    commandKey(agent,fileKey,item.index,'portable-shelf'));
    requireImportOwnerAvailable(response);
    if (response.ok && response.status !== 202) return { applied: ['shelf'], issues: [] };
    return response.status === 202 ? null : { applied: ['private-source'],issues: ['shelf-failed'] };
  }
  if (!work) return { applied: ['private-source'], issues: ['unresolved-work'] };
  const target = choice?.target ?? item.match?.target ?? row.target ?? work;
  const rating = globalImportRating(row);
  const context = row.kind === 'entry' && typeof row.raw.ratingContext === 'string' ? row.raw.ratingContext : intent.context;
  const batch: ReviewedImportBatch = { actingSubject: agent, context,
    language: intent.language, existingShelves: [], rows: [{ work,
      status: row.status === 'paused' ? 'reading' : row.status === 'dnf' ? null : row.status,
      applyStatus: row.kind === 'entry' && 'sessionProjection' in row.raw,
      startedOn: day(row.startedOn), finishedOn: day(row.finishedOn), rating,
      hasRating: rating !== null && context !== null, review: row.review?.text ?? null,
      reviewVisibility: 'private', reviewLanguage: row.review?.language === 'und' ? intent.language : row.review?.language,
      reviewSpoiler: row.review?.spoiler, shelves: row.shelves, conflictChoice: choice?.conflictChoice }] };
  // Sessions export first, potentially in a different uploaded page. An explicit
  // portable Library statement supersedes their projection, including a manual
  // clear. The reader's reviewed keep/replace choice still takes precedence.
  if (row.kind === 'entry' && 'sessionProjection' in row.raw && !choice?.conflictChoice) {
    batch.rows[0]!.conflictChoice = 'replace';
  }
  if (row.kind === 'entry' && row.raw.disclosure === 'public') {
    batch.shelfDisclosures = Object.fromEntries(row.shelves.map(name => [name,'public' as const]));
  }
  if (row.kind === 'entry' && typeof row.raw.shelfId === 'string') {
    batch.existingShelves = row.shelves.map(name => ({ name,id: portableShelfId(agent,row.raw.shelfId as string) }));
  }
  const commands = new ImportCommands(store,request,batch,fileKey);
  const inferred = row.kind === 'source' && ['read','reading','paused','dnf'].includes(row.status ?? '')
    && choice?.conflictChoice !== 'keep';
  const legacyRead = row.kind === 'entry' && row.status === 'read' && row.raw.sessionProjection === null
    && choice?.conflictChoice !== 'keep';
  // Ordinary reviewed rows already do one state read. Only session orchestration
  // needs this earlier read, before creating an attempt or preserving a legacy read.
  const state = inferred || legacyRead || row.session ? await readSessionImportState<{ status: { status: string | null; startedOn: string | null;
    finishedOn: string | null; version: number } }>(store,request,`/v1/works/${uuid(work)}/reader-state?actingSubject=${encodeURIComponent(agent)}`)
    : { status: { status: null,startedOn: null,finishedOn: null,version: 0 } };
  if (!state) return null;
  const desired = batch.rows[0]!.status;
  if (row.kind !== 'session' && state.status.status !== null && desired !== null && desired !== state.status.status
    && !choice?.conflictChoice) return { applied: [], issues: ['status-changed'] };
  let session = row.session;
  if (inferred || legacyRead) session = { target,
    state: row.status === 'read' ? 'finished' : row.status === 'paused' ? 'paused' : row.status === 'dnf' ? 'dnf' : 'active',
    startedOn: row.startedOn, finishedOn: row.finishedOn,
    selections: [{ target }], locators: row.progress && target !== work
      ? [{ target, unit: row.progress.unit, current: row.progress.value, furthest: row.progress.value }] : [] };
  const applied: string[] = [];
  if (session) {
    // Preserve a pre-existing completion before starting the first imported reread.
    if (inferred && state.status.status === 'read' && (row.status !== 'read'
      || row.startedOn !== state.status.startedOn || row.finishedOn !== state.status.finishedOn)) {
      const history = await readSessionImportState<{ items: SessionState[] }>(store,request,`/v1/me/sessions?actingSubject=${encodeURIComponent(agent)}&work=${encodeURIComponent(work)}&limit=1`);
      if (!history) return null;
      if (!history.items.length && !await sessionStep(store,request,agent,fileKey,item.index,'legacy-completion','POST',
        '/v1/me/sessions',{ actingSubject: agent,target: work,expectedVersion: 0,state: 'finished',
          startedOn: state.status.startedOn,finishedOn: state.status.finishedOn })) return null;
    }
    const existing = await findImportSession(store,request,agent,{ ...row,work },format,session);
    if (!existing) return null;
    let saved = existing.session;
    const sourceKey = `source-session:${existing.identity}:${importDigest(session).slice(0,32)}`;
    // Plans are still upload-local, but the API key is bound to source and
    // desired state, independently of the upload's fresh Idempotency-Key.
    if (!saved || !existing.replay && !importSessionMatches(saved,session)) {
      const method = saved ? 'PATCH' : 'POST';
      const path = saved ? `/v1/me/sessions/${uuid(saved.id)}` : '/v1/me/sessions';
      const key = commandKey(agent,sourceKey,0,'session');
      const held = await store.planStep(agent,fileKey,item.index,'session',{ method,path,key,body: {
        actingSubject: agent,...(!saved ? { target: session.target } : {}),expectedVersion: saved?.version ?? 0,
        state: session.state,startedOn: session.startedOn,finishedOn: session.finishedOn,addSelections: [{ target: session.target,...session.selections.find(selection => selection.target===session.target) },
          ...session.selections.filter(selection => selection.target!==session.target)] } });
      const plan = held.plan as { method: string; path: string; key: string; body: object };
      const response = await mainCall(store,request,plan.method,plan.path,plan.body,plan.key);
      requireImportOwnerAvailable(response);
      if (response.status === 202) return null;
      if (!response.ok) throw new ImportSessionFailed('Session import command was refused');
      saved = await response.json() as SessionState;
      await store.completeStep(agent,fileKey,item.index,'session');
    }
    if (!saved) return null;
    if (!existing.replay) {
      for (const [index,locator] of session.locators.entries()) {
        const prior = saved.locators.find(position => position.target===locator.target && position.unit===locator.unit);
        if (prior?.current===locator.current && prior.furthest===locator.furthest) continue;
        for (const [part,value] of [['furthest',locator.furthest],['current',locator.current]] as const) {
          saved = await sessionStep(store,request,agent,fileKey,item.index,`locator-${index}-${part}`,'PATCH',
            `/v1/me/sessions/${uuid(saved.id)}`,{ actingSubject: agent,expectedVersion: saved.version,
              position: { target: locator.target,unit: locator.unit,value } });
          if (!saved) return null;
        }
      }
    }
    await bindImportSession(store,agent,existing.identity,saved,session);
    applied.push('session');
    // Session commands own the status projection; the explicit export Library
    // row restores any later manual statement independently.
    batch.rows[0]!.status = null;
    batch.rows[0]!.applyStatus = false;
  }
  if (row.kind === 'session') return { applied, issues: [] };
  if (row.kind === 'entry' && typeof row.raw.ratingContext === 'string'
    && row.score?.max === 10) {
    const header = await commands.read<{ mainVersion: string }>(`/v1/works/${uuid(work)}?actingSubject=${encodeURIComponent(agent)}`);
    if (!header) return null;
    const step = await commands.step(item.index,'portable-rating','POST','/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1',
      context: row.raw.ratingContext,work,mainVersion: header.mainVersion,expectedRevisionHead: null,
      value: row.score?.value ?? null,actingSubject: agent });
    if (step === 'retry') return null;
    if (step !== 'complete') return { applied,issues: ['rating-failed'] };
    applied.push('rating');
  }
  const result = await importReviewedBatch(store,request,batch,commandKey(agent,fileKey,item.index,'reviewed'));
  if (result.pending) return null;
  const outcome = result.items[0]?.result;
  return outcome ? { applied: [...applied,...outcome.applied,'private-source'],issues: outcome.issues } : null;
}

export async function applyLibraryFile(files: LibraryFileStore, store: ReaderLibraryImportStore,
  request: Request, agent: string, id: string, intent: ApplyIntent,token?: string) {
  await files.seal(agent,id,intent);
  const file = await files.file(agent,id);
  await store.withBatch(agent,'library-file-agent-apply',async () => {
    for (const item of await files.pending(agent,id)) {
      const reviewedKey = commandKey(agent,file.import_key,item.index,'reviewed');
      await files.pool.query(`INSERT INTO reader.library_import_file_batch(agent,file_id,import_key)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[agent,id,reviewedKey]);
      try {
        const outcome = await applyRow(store,request,agent,file.import_key,item,intent,file.format);
        if (!outcome) break;
        await files.complete(agent,id,item.index,outcome,token);
      } catch (error) {
        if (!(error instanceof ImportSessionFailed)) throw error;
        await files.complete(agent,id,item.index,{ applied: ['private-source'],issues: ['session-failed'] },token);
      }
    }
  },request.signal);
  return files.progress(agent,id);
}
