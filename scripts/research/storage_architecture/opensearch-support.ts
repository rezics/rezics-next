export const REALM = {
  publication: 'publication:realm-A',
  classification: 'classification:realm-A',
  rating: 'rating:realm-A',
} as const;
export const TERM = '中文';
export const AGENT = 'agent:A';
export const SENSE = 'sense:accepted';
export const COMMON_SENSE = 'sense:common';
export const RATING_MIN = 8;

export type LocalDecision = 'absent' | 'accept' | 'reject' | 'unavailable';
export interface Credit { agent: string; role: string; occurrence: string }
export interface TextUnit {
  revisionId: string;
  field: string;
  body: string;
  selectionKind: 'baseline' | 'local';
  positiveContexts: string[];
  shadowedContexts: string[];
}
export interface Classification {
  senseId: string;
  globalAccept: boolean;
  localAcceptContexts: string[];
  localRejectContexts: string[];
}
export interface Rating { contextId: string; sum: number; count: number; meanFloorTimes10: number }
export interface SearchRoot {
  rootId: string;
  textUnits: TextUnit[];
  credits: Credit[];
  classifications: Classification[];
  ratings: Rating[];
  fixtureState: {
    publication: LocalDecision;
    classification: LocalDecision;
    selectedText: string;
    globalText: string;
    creditOccurrences: Credit[];
    globalSenseAccepted: boolean;
    ratingSum: number;
    ratingCount: number;
    ratingContext: string;
  };
}

const normalized = (value: string) => value.normalize('NFKC').toLowerCase();
export function oracleEligibleFor(root: SearchRoot, role:'translator'|'author', sense:'accepted'|'common'): boolean {
  const state = root.fixtureState;
  if (state.publication === 'unavailable' || state.classification === 'unavailable') {
    throw new Error(`Search checkpoint is not ready for ${root.rootId}`);
  }
  const selected = state.publication === 'accept' ? state.selectedText :
    state.publication === 'absent' ? state.globalText : '';
  const classified = sense === 'common' ? true : state.classification === 'accept' ||
    (state.classification === 'absent' && state.globalSenseAccepted);
  const credit = state.creditOccurrences.some(c => c.agent === AGENT && c.role === role);
  return normalized(selected).includes(normalized(TERM)) && classified && credit &&
    state.ratingContext === REALM.rating && state.ratingCount > 0 &&
    10 * state.ratingSum >= 80 * state.ratingCount;
}
export const oracleEligible=(root:SearchRoot)=>oracleEligibleFor(root,'translator','accepted');

export function makeRoot(i: number, scale: number): SearchRoot {
  const rootId = `resource:${String(i).padStart(6,'0')}`;
  const isTarget = i >= scale - 5;
  let publication: LocalDecision = 'absent';
  let classification: LocalDecision = 'absent';
  let globalText = '中文';
  let selectedText = '中文';
  let globalSenseAccepted = false;
  let creditOccurrences: Credit[] = [{agent:AGENT,role:'author',occurrence:'credit:0'},{agent:'agent:B',role:'translator',occurrence:'credit:1'}];
  let ratingSum = 9;
  let ratingCount = 1;
  if (isTarget) {
    globalSenseAccepted = true;
    creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}];
    globalText = '這是一段較長的作品說明，其中有中文內容，可用於測量完整關係篩選後的排序。';
    if (i >= scale - 2) {
      publication = 'accept';
      selectedText = '採用於此 Realm 的另一段較長正文，其中包含中文並已完成翻譯。';
    }
    if (i === scale - 1) { globalSenseAccepted = false; classification = 'accept'; }
  }
  // Explicit negative controls are early in text ranking, so text-first topK is unsafe.
  if (i === 0) { globalSenseAccepted = true; ratingSum = 6; creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}]; }
  if (i === 1) { globalSenseAccepted = true; classification = 'reject'; creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}]; }
  if (i === 2) { globalSenseAccepted = true; publication = 'reject'; creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}]; }
  if (i === 3) { globalSenseAccepted = true; publication = 'accept'; selectedText = '本地採用正文沒有關鍵詞'; creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}]; }
  if (i === 4) { globalSenseAccepted = false; classification = 'accept'; ratingSum = 6; creditOccurrences = [{agent:AGENT,role:'translator',occurrence:'credit:0'}]; }
  if (i === 5) { globalSenseAccepted = true; creditOccurrences = [{agent:AGENT,role:'author',occurrence:'credit:0'},{agent:'agent:B',role:'translator',occurrence:'credit:1'}]; }
  const shadowedContexts = publication === 'absent' ? [] : [REALM.publication];
  const textUnits:TextUnit[] = [{revisionId:`revision:${i}:global`,field:'body',body:globalText,selectionKind:'baseline',positiveContexts:[],shadowedContexts}];
  if(publication==='accept')textUnits.push({revisionId:`revision:${i}:local`,field:'body',body:selectedText,selectionKind:'local',positiveContexts:[REALM.publication],shadowedContexts:[]});
  return {
    rootId,textUnits,credits:creditOccurrences,
    classifications:[{senseId:SENSE,globalAccept:globalSenseAccepted,localAcceptContexts:classification==='accept'?[REALM.classification]:[],localRejectContexts:classification==='reject'?[REALM.classification]:[]},{senseId:COMMON_SENSE,globalAccept:true,localAcceptContexts:[],localRejectContexts:[]}],
    ratings:[{contextId:REALM.rating,sum:ratingSum,count:ratingCount,meanFloorTimes10:ratingCount>0?Math.floor(10*ratingSum/ratingCount):-1}],
    fixtureState:{publication,classification,selectedText,globalText,creditOccurrences,globalSenseAccepted,ratingSum,ratingCount,ratingContext:REALM.rating},
  };
}

export function toIndexed(root: SearchRoot) {
  const {fixtureState: _fixtureState,...indexed}=root;
  return indexed;
}

export function joinedQuery(size:number, role:'translator'|'author'='translator', sense:'accepted'|'common'='accepted') {
  const pub=REALM.publication, cls=REALM.classification;
  const selectedSense=sense==='common'?COMMON_SENSE:SENSE;
  const local = {bool:{must:[{match:{'textUnits.body':TERM}}],filter:[{term:{'textUnits.selectionKind':'local'}},{term:{'textUnits.positiveContexts':pub}}]}};
  const baseline = {bool:{must:[{match:{'textUnits.body':TERM}}],filter:[{term:{'textUnits.selectionKind':'baseline'}}],must_not:[{term:{'textUnits.shadowedContexts':pub}}]}};
  return {size,track_total_hits:true,_source:false,
    query:{bool:{must:[{nested:{path:'textUnits',score_mode:'max',query:{bool:{should:[local,baseline],minimum_should_match:1}}}}],filter:[
      {nested:{path:'credits',score_mode:'none',query:{bool:{filter:[{term:{'credits.agent':AGENT}},{term:{'credits.role':role}}]}}}},
      {nested:{path:'classifications',score_mode:'none',query:{bool:{filter:[{term:{'classifications.senseId':selectedSense}}],should:[
        {term:{'classifications.localAcceptContexts':cls}},
        {bool:{filter:[{term:{'classifications.globalAccept':true}}],must_not:[{term:{'classifications.localRejectContexts':cls}}]}}
      ],minimum_should_match:1}}}},
      {nested:{path:'ratings',score_mode:'none',query:{bool:{filter:[{term:{'ratings.contextId':REALM.rating}},{range:{'ratings.meanFloorTimes10':{gte:80}}}]}}}}
    ]}},sort:[{'_score':'desc'},{rootId:'asc'}]};
}

export function broadQuery(size:number) {
  const pub=REALM.publication;
  return {size,track_total_hits:true,_source:false,query:{nested:{path:'textUnits',score_mode:'max',query:{bool:{should:[
    {bool:{must:[{match:{'textUnits.body':TERM}}],filter:[{term:{'textUnits.selectionKind':'local'}},{term:{'textUnits.positiveContexts':pub}}]}},
    {bool:{must:[{match:{'textUnits.body':TERM}}],filter:[{term:{'textUnits.selectionKind':'baseline'}}],must_not:[{term:{'textUnits.shadowedContexts':pub}}]}}
  ],minimum_should_match:1}}}},sort:[{'_score':'desc'},{rootId:'asc'}]};
}

export const INDEX_DEFINITION = {
  settings:{number_of_shards:1,number_of_replicas:0,refresh_interval:'-1',index:{max_result_window:100000}},
  mappings:{dynamic:'strict',properties:{
    rootId:{type:'keyword'},
    textUnits:{type:'nested',properties:{revisionId:{type:'keyword'},field:{type:'keyword'},body:{type:'text',analyzer:'cjk'},selectionKind:{type:'keyword'},positiveContexts:{type:'keyword'},shadowedContexts:{type:'keyword'}}},
    credits:{type:'nested',properties:{agent:{type:'keyword'},role:{type:'keyword'},occurrence:{type:'keyword'}}},
    classifications:{type:'nested',properties:{senseId:{type:'keyword'},globalAccept:{type:'boolean'},localAcceptContexts:{type:'keyword'},localRejectContexts:{type:'keyword'}}},
    ratings:{type:'nested',properties:{contextId:{type:'keyword'},sum:{type:'integer'},count:{type:'integer'},meanFloorTimes10:{type:'integer'}}},
  }}
} as const;
