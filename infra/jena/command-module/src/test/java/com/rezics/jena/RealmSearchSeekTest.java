package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class RealmSearchSeekTest {
    private static final Node CURRENT=NodeFactory.createURI(CommandPolicy.CURRENT), PUBLIC=NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), REVISIONS=NodeFactory.createURI(CommandPolicy.REVISIONS);
    private static Node p(String name){return NodeFactory.createURI("https://rezics.com/vocab/"+name);}
    private static Node id(int n){return NodeFactory.createURI(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d",n));}
    private static Node label(){return NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label");}
    private static final Node REALM=id(1),SPACE=id(2);
    private static final String ALIAS="Maintained realm alias",BODY="Realm selected passage";
    private static void set(DatasetGraph data,Node graph,Node subject,String predicate,Node value){data.deleteAny(graph,subject,p(predicate),Node.ANY);data.add(graph,subject,p(predicate),value);}
    private record Owner(Node work,Node main,Node unit,Node selection,Node contribution,Node decision,Node draft,Node slot){}
    private static final class Fixture implements AutoCloseable {
        final FilteredGraphTextIndex index; final DatasetGraphText data;
        Fixture(){
            var definition=new EntityDefinition("uri","label","graph");definition.set("body",p("searchBody"));definition.set("publicTitle",p("publicTitle"));definition.set("label",label());definition.setLangField("lang");definition.setUidField("uid");
            var config=new TextIndexConfig(definition);config.setValueStored(true);
            index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
            data=new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),index,new TextDocProducerTriples(index));index.bindRankData(data);
            data.begin(ReadWrite.WRITE);
            data.add(CURRENT,SPACE,RDF.type.asNode(),p("Space"));data.add(CURRENT,SPACE,p("disclosure"),p("Public"));
            data.add(CURRENT,REALM,RDF.type.asNode(),p("Realm"));data.add(CURRENT,REALM,p("space"),SPACE);data.add(CURRENT,REALM,p("realmState"),p("Active"));
        }
        Owner owner(int n,boolean realm,boolean names,String body,Node bookMain)throws Exception {
            Node work=id(n),main=id(n+1),selection=id(n+2),contribution=id(n+3),decision=id(n+4),draft=id(n+5),unit=id(n+6);
            Node context=realm?REALM:main;
            Node slot=realm?NodeFactory.createURI("urn:rezics:realm-selection:"+HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest((REALM.getURI()+"\0"+main.getURI()).getBytes(java.nio.charset.StandardCharsets.UTF_8)))):main;
            data.add(CURRENT,work,RDF.type.asNode(),NodeFactory.createURI("https://schema.org/CreativeWork"));
            data.add(CURRENT,work,p("mainVersion"),main);data.add(CURRENT,work,p("catalogueVisible"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
            data.add(CURRENT,main,RDF.type.asNode(),p("MainVersion"));data.add(CURRENT,main,p("work"),work);
            data.add(CURRENT,slot,p("selectionHead"),selection);
            if(realm){data.add(CURRENT,slot,RDF.type.asNode(),p("RealmPublicationSlot"));data.add(CURRENT,slot,p("realm"),REALM);data.add(CURRENT,slot,p("mainVersion"),main);data.add(CURRENT,slot,p("work"),work);}
            data.add(CURRENT,contribution,p("work"),work);data.add(CURRENT,contribution,p("publicationHead"),decision);
            data.add(REVISIONS,selection,RDF.type.asNode(),p("PublicationSelection"));
            for(var entry:Map.of("work",work,"mainVersion",main,"context",context,"contribution",contribution,"publicationDecision",decision,"selectedDraft",draft,"language",NodeFactory.createLiteralString("zh-Hant")).entrySet())data.add(REVISIONS,selection,p(entry.getKey()),entry.getValue());
            if(realm)data.add(REVISIONS,selection,p("slot"),slot);
            data.add(REVISIONS,decision,RDF.type.asNode(),p("PublicationDecision"));
            for(var entry:Map.of("component",contribution,"work",work,"contribution",contribution,"selectedDraft",draft,"disclosure",p("Public")).entrySet())data.add(REVISIONS,decision,p(entry.getKey()),entry.getValue());
            data.add(REVISIONS,draft,RDF.type.asNode(),p("RevisionAnchor"));data.add(REVISIONS,draft,p("component"),contribution);
            data.add(PUBLIC,unit,RDF.type.asNode(),p("MatchUnit"));
            for(var entry:Map.of("work",work,"mainVersion",main,"context",context,"selection",selection,"contribution",contribution,"revision",draft,"language",NodeFactory.createLiteralString("zh-Hant"),"disclosure",p("Public")).entrySet())data.add(PUBLIC,unit,p(entry.getKey()),entry.getValue());
            if(bookMain!=null){data.add(PUBLIC,unit,p("searchResultMain"),bookMain);data.add(PUBLIC,unit,p("searchResultWork"),id(Integer.parseInt(bookMain.getURI().substring(bookMain.getURI().length()-12))-1));}
            data.add(PUBLIC,unit,p("searchBody"),NodeFactory.createLiteralLang(body,"zh-Hant"));
            if(names){data.add(CURRENT,work,label(),NodeFactory.createLiteralLang(ALIAS,"fr"));PublicNameProjection.refresh(data,work);}
            return new Owner(work,main,unit,selection,contribution,decision,draft,slot);
        }
        void committed(){data.commit();data.end();}
        @Override public void close(){if(data.isInTransaction()){data.abort();data.end();}data.close();}
    }
    private static final class Measured extends DatasetGraphWrapper {
        long rows;
        Measured(DatasetGraph data){super(data);}
        @Override public Iterator<Quad> find(Node graph,Node subject,Node predicate,Node object){
            if(PUBLIC.equals(graph)&&Node.ANY.equals(subject)&&Set.of(p("context"),p("mainVersion"),p("searchResultMain")).contains(predicate))
                throw new AssertionError("ranked read enumerated a population: "+predicate);
            return org.apache.jena.util.iterator.WrappedIterator.create(super.find(graph,subject,predicate,object)).mapWith(quad->{rows++;return quad;});
        }
    }
    private record Scan(List<FilteredGraphTextIndex.RankHit> hits,int pages,long maxRows,long maxGroups,int emptyPages,long maxWitnesses,long maxScores,long maxMoves,long maxCollections){}
    private static long count(CommandWork work,String name){var match=java.util.regex.Pattern.compile("(?:^|,)"+name+"=([0-9]+)").matcher(work.counters());return match.find()?Long.parseLong(match.group(1)):0;}
    private static Scan scan(Fixture fixture,String phrase,String realm,int size){
        var all=new ArrayList<FilteredGraphTextIndex.RankHit>();var seen=new HashSet<String>();int pages=0,empty=0;long maxRows=0,maxGroups=0,maxWitnesses=0,maxScores=0,maxMoves=0,maxCollections=0;
        FilteredGraphTextIndex.RankAfter after=null;fixture.data.begin(ReadWrite.READ);
        try{
            for(;;){
                var measured=new Measured(fixture.data);FilteredGraphTextIndex.RankPage page;
                try(var work=new CommandWork()){
                    page=fixture.index.ranked(p("searchBody"),phrase,size,after,measured,new FilteredGraphTextIndex.RankScope(realm,"zh-Hant",null,true));
                    maxGroups=Math.max(maxGroups,count(work,"rank_group_candidates_visited"));
                    maxWitnesses=Math.max(maxWitnesses,count(work,"rank_live_witnesses_visited"));
                    maxScores=Math.max(maxScores,count(work,"rank_lucene_score_calls"));
                    maxMoves=Math.max(maxMoves,count(work,"rank_lucene_iterator_next_calls")+count(work,"rank_lucene_iterator_advance_calls"));
                    maxCollections=Math.max(maxCollections,count(work,"rank_lucene_collection_events"));
                    assertTrue("snapshot witness ceiling exceeded",count(work,"rank_live_witnesses_visited")<=128);
                }
                maxRows=Math.max(maxRows,measured.rows);pages++;assertTrue("cursor did not finish",pages<2000);
                int visible=0;for(var hit:page.hits())if(hit.key()!=null){assertTrue("group repeated across pages",seen.add(hit.key()));all.add(hit);visible++;}
                if(visible==0)empty++;
                if(!page.more())break;
                assertFalse(page.hits().isEmpty());var last=page.hits().getLast();var next=new FilteredGraphTextIndex.RankAfter(last.id(),last.score(),page.commit(),last.document());
                assertNotEquals(after,next);after=next;
            }
        }finally{fixture.data.end();}
        return new Scan(all,pages,maxRows,maxGroups,empty,maxWitnesses,maxScores,maxMoves,maxCollections);
    }
    @Test public void realmBodyPostingSeekIsCompleteAndIndependentOfAdoptionAndUnrelatedPopulation()throws Exception{
        for(int population:List.of(1,1500))try(var fixture=new Fixture()){
            var expected=new HashSet<String>();
            for(int i=0;i<81;i++)expected.add(fixture.owner(10000+i*10,true,false,BODY,null).main().getURI());
            for(int i=0;i<population;i++)fixture.owner(30000+i*10,true,false,"Different realm text",null);
            for(int i=0;i<population;i++)fixture.owner(60000+i*10,false,false,BODY,null);
            fixture.committed();var result=scan(fixture,BODY,REALM.getURI(),13);
            assertEquals(expected,new HashSet<>(result.hits().stream().map(FilteredGraphTextIndex.RankHit::key).toList()));assertTrue(result.pages()>1);
            assertTrue("RDF work grew with population: "+result.maxRows(),result.maxRows()<=13*100);assertEquals(13,result.maxGroups());
            System.out.println("realm body adoption/unrelated="+population+" pages="+result.pages()+" maxRows="+result.maxRows()+" groupProbes="+result.maxGroups()+" ownerWitnesses="+result.maxWitnesses()+" observedScoreCalls="+result.maxScores()+" iteratorMoves="+result.maxMoves()+" collectionEvents="+result.maxCollections());
        }
    }
    @Test public void completeRealmNamesAdvanceThroughUnrelatedNamesWithoutASilentPopulationCap()throws Exception{
        try(var fixture=new Fixture()){
            for(int i=0;i<2100;i++)fixture.owner(10000+i*10,false,true,"Different default text",null);
            var expected=new HashSet<String>();for(int i=0;i<81;i++)expected.add(fixture.owner(50000+i*10,true,true,"Different adopted text",null).main().getURI());
            fixture.committed();var result=scan(fixture,ALIAS,REALM.getURI(),64);
            assertEquals(expected,new HashSet<>(result.hits().stream().map(FilteredGraphTextIndex.RankHit::key).toList()));assertTrue(result.emptyPages()>20);assertTrue(result.maxRows()<=64*100);assertTrue(result.maxGroups()<=64);
            System.out.println("realm names unrelated=2100 results="+result.hits().size()+" pages="+result.pages()+" empty="+result.emptyPages()+" maxRows="+result.maxRows());
        }
    }
    @Test public void chapterGroupingUsesPostingsAndSkipsAnEntireStaleThousandNameIdentityOnce()throws Exception{
        for(int chapters:List.of(1,1200))try(var fixture=new Fixture()){
            var book=fixture.owner(90000,false,false,"Unmatched book text",null);
            for(int i=0;i<1001;i++)fixture.data.add(CURRENT,book.work(),NodeFactory.createURI("https://schema.org/alternateName"),NodeFactory.createLiteralLang(BODY+" alias "+i,"fr"));
            PublicNameProjection.refresh(fixture.data,book.work());
            for(int i=0;i<17;i++)PublicNameProjection.repairNameLabels(fixture.data,"urn:receipt:realm-book-labels:"+i);
            var owners=new ArrayList<Owner>();for(int i=0;i<chapters;i++)owners.add(fixture.owner(100000+i*10,true,false,BODY,null));
            for(var owner:owners){fixture.data.add(PUBLIC,owner.unit(),p("searchResultMain"),book.main());fixture.data.add(PUBLIC,owner.unit(),p("searchResultWork"),book.work());fixture.index.refreshRankSubject(fixture.data,owner.unit().getURI());}
            fixture.committed();var result=scan(fixture,BODY,REALM.getURI(),16);
            assertEquals(1,result.hits().size());assertEquals(book.main().getURI(),result.hits().getFirst().key());assertTrue(result.maxGroups()<=32);assertTrue(result.maxRows()<=16*150);
            System.out.println("realm chapters="+chapters+" names=1001 pages="+result.pages()+" maxRows="+result.maxRows()+" groupProbes="+result.maxGroups()+" ownerWitnesses="+result.maxWitnesses()+" observedScoreCalls="+result.maxScores()+" iteratorMoves="+result.maxMoves()+" collectionEvents="+result.maxCollections());
            if(chapters>1){
                Node winner=NodeFactory.createURI(result.hits().getFirst().id());Owner stale=owners.stream().filter(owner->owner.unit().equals(winner)).findFirst().orElseThrow();
                fixture.data.begin(ReadWrite.WRITE);fixture.data.add(REVISIONS,stale.draft(),RDF.type.asNode(),p("ErasedRevision"));fixture.committed();
                var next=scan(fixture,BODY,REALM.getURI(),16);assertEquals(1,next.hits().size());assertNotEquals(winner.getURI(),next.hits().getFirst().id());assertTrue(next.maxGroups()<=48);
            }
        }
    }
    @Test public void realmAndCurrentPublicationWithdrawalDenyBodyAndNameCandidatesBeforeRepair()throws Exception{
        try(var fixture=new Fixture()){
            var adopted=fixture.owner(10000,true,true,BODY,null);fixture.committed();
            assertEquals(1,scan(fixture,BODY,REALM.getURI(),64).hits().size());assertEquals(1,scan(fixture,ALIAS,REALM.getURI(),64).hits().size());
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,adopted.slot(),"selectionHead",id(99999));fixture.committed();
            assertTrue(scan(fixture,BODY,REALM.getURI(),64).hits().isEmpty());assertTrue(scan(fixture,ALIAS,REALM.getURI(),64).hits().isEmpty());
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,adopted.slot(),"selectionHead",adopted.selection());fixture.committed();
            for(String reason:List.of("private","retired","space-erased","publication","draft")){
                fixture.data.begin(ReadWrite.WRITE);
                if(reason.equals("private"))set(fixture.data,CURRENT,SPACE,"disclosure",p("Private"));
                if(reason.equals("retired"))set(fixture.data,CURRENT,REALM,"realmState",p("Retired"));
                if(reason.equals("space-erased")){set(fixture.data,CURRENT,SPACE,"head",id(99999));fixture.data.add(REVISIONS,id(99999),RDF.type.asNode(),p("ErasedRevision"));}
                if(reason.equals("publication"))set(fixture.data,CURRENT,adopted.contribution(),"publicationHead",id(99999));
                if(reason.equals("draft"))fixture.data.add(REVISIONS,adopted.draft(),RDF.type.asNode(),p("ErasedRevision"));
                fixture.committed();assertTrue(reason,scan(fixture,BODY,REALM.getURI(),64).hits().isEmpty());assertTrue(reason,scan(fixture,ALIAS,REALM.getURI(),64).hits().isEmpty());
                fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,SPACE,"disclosure",p("Public"));set(fixture.data,CURRENT,REALM,"realmState",p("Active"));set(fixture.data,CURRENT,adopted.contribution(),"publicationHead",adopted.decision());fixture.data.deleteAny(CURRENT,SPACE,p("head"),Node.ANY);fixture.data.delete(REVISIONS,id(99999),RDF.type.asNode(),p("ErasedRevision"));fixture.data.delete(REVISIONS,adopted.draft(),RDF.type.asNode(),p("ErasedRevision"));fixture.committed();
            }
            assertEquals(1,scan(fixture,BODY,REALM.getURI(),64).hits().size());assertEquals(1,scan(fixture,ALIAS,REALM.getURI(),64).hits().size());
        }
    }
    @Test public void metadataRefreshPreservesOtherMappedFieldsAndSharesRollbackAndResetWithTheWriter()throws Exception{
        try(var fixture=new Fixture()){
            var owner=fixture.owner(10000,true,false,BODY,null);
            fixture.data.add(PUBLIC,owner.unit(),label(),NodeFactory.createLiteralLang("Preserved mapped label","fr"));
            for(int i=0;i<64;i++)fixture.data.add(PUBLIC,owner.unit(),p("publicTitle"),NodeFactory.createLiteralLang("Cached title "+i,"fr"));
            Node control=NodeFactory.createURI(CommandPolicy.CONTROL),product=NodeFactory.createURI("urn:rezics:dataset:product");
            fixture.data.add(control,product,p("dataEpoch"),NodeFactory.createLiteralString("epoch"));fixture.data.add(control,product,p("routingEpoch"),NodeFactory.createLiteralString("route"));
            fixture.data.add(control,product,p("sequence"),NodeFactory.createLiteralByValue(java.math.BigInteger.ZERO,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            fixture.data.add(control,product,p("textIndexGeneration"),NodeFactory.createURI("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
            SearchDeltaJournal.initialize(fixture.data);
            try(var measured=new CommandWork()){
                SearchDeltaJournal.append(new DatasetGraphWrapper(fixture.data),new SearchDeltaJournal.Capture(fixture.data,true),0);
                assertEquals(65,count(measured,"rank_metadata_values_visited"));
            }
            fixture.committed();assertFalse(fixture.index.rankMetadataMissing());
            assertEquals(1,fixture.index.lucene().query(label(),"Preserved mapped label",CommandPolicy.PUBLIC_SEARCH,"fr",10).size());
            fixture.data.begin(ReadWrite.WRITE);
            var capture=new SearchDeltaJournal.Capture(fixture.data);var observed=capture.observed();
            set(observed,PUBLIC,owner.unit(),"context",owner.main());
            SearchDeltaJournal.append(fixture.data,capture,1);fixture.data.abort();fixture.data.end();
            assertEquals(1,scan(fixture,BODY,REALM.getURI(),64).hits().size());
            assertEquals(1,fixture.index.lucene().query(label(),"Preserved mapped label",CommandPolicy.PUBLIC_SEARCH,"fr",10).size());
            fixture.data.begin(ReadWrite.WRITE);capture=new SearchDeltaJournal.Capture(fixture.data);observed=capture.observed();
            set(observed,PUBLIC,owner.unit(),"context",owner.main());SearchDeltaJournal.append(fixture.data,capture,2);fixture.committed();
            assertTrue(scan(fixture,BODY,REALM.getURI(),64).hits().isEmpty());
            fixture.data.begin(ReadWrite.WRITE);capture=new SearchDeltaJournal.Capture(fixture.data);observed=capture.observed();
            set(observed,PUBLIC,owner.unit(),"context",REALM);SearchDeltaJournal.append(fixture.data,capture,3);fixture.committed();
            assertEquals(1,scan(fixture,BODY,REALM.getURI(),64).hits().size());
        }
    }
    @Test public void existingStartupReplaySeedsMixedBodyTitleMetadataAndTheOriginalJenaLanguageFactory()throws Exception{
        try(var fixture=new Fixture()){
            var owner=fixture.owner(10000,true,false,"Different body",null);
            var literal=NodeFactory.createLiteralLang("Legacy cached realm title","zh-Hant");
            fixture.data.add(PUBLIC,owner.unit(),p("publicTitle"),literal);fixture.committed();
            var entity=new Entity(owner.unit().getURI(),CommandPolicy.PUBLIC_SEARCH,"zh-Hant",literal.getLiteralDatatype());entity.put("publicTitle",literal.getLiteralLexicalForm());
            fixture.data.begin(ReadWrite.WRITE);fixture.index.deleteEntity(entity);fixture.index.lucene().addEntity(entity);fixture.committed();
            assertTrue(fixture.index.rankMetadataMissing());assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(fixture.data));assertFalse(fixture.index.rankMetadataMissing());
            assertEquals(1,scan(fixture,"Legacy cached realm title",REALM.getURI(),64).hits().size());
            assertEquals(1,fixture.index.lucene().query(p("publicTitle"),"Legacy cached realm title",CommandPolicy.PUBLIC_SEARCH,"zh-Hant",10).size());
            assertFalse(OccurrenceTextSchema.rebuildIfIncompatible(fixture.data));
        }
        for(boolean stored:List.of(false,true)){
            var definition=new EntityDefinition("uri","label","graph");definition.set("body",p("searchBody"));definition.setLangField("lang");definition.setUidField("uid");
            var config=new TextIndexConfig(definition);config.setValueStored(stored);config.setMultilingualSupport(true);
            var lucene=new TextIndexLucene(new ByteBuffersDirectory(),config);
            try{
                var entity=new Entity(id(91000).getURI(),CommandPolicy.PUBLIC_SEARCH,"zh-Hant",null);entity.put("body",BODY);
                var document=org.apache.jena.query.text.RezicsLuceneDocument.build(lucene,entity);
                assertEquals(stored,document.getField("body").fieldType().stored());
                assertEquals("zh-Hant",document.get("lang"));assertEquals(entity.getChecksum("body",BODY),document.get("uid"));
                assertTrue(document.getFields().stream().anyMatch(field->field.name().startsWith("body_")||field.name().startsWith("body@")));
            }finally{lucene.close();}
        }
    }
    @Test public void unresolvedGroupWitnessBudgetIsExplicitAndRepairRestoresTheLowerEligibleChapter()throws Exception{
        try(var fixture=new Fixture()){
            var book=fixture.owner(90000,false,false,"Unmatched book",null);
            var stale=new ArrayList<Owner>();
            for(int i=0;i<65;i++){
                var owner=fixture.owner(100000+i*10,true,false,BODY,book.main());stale.add(owner);
                fixture.data.add(REVISIONS,owner.draft(),RDF.type.asNode(),p("ErasedRevision"));
            }
            var valid=fixture.owner(120000,true,false,BODY,book.main());fixture.committed();
            assertThrows(TextIndexException.class,()->scan(fixture,BODY,REALM.getURI(),64));
            fixture.data.begin(ReadWrite.WRITE);for(var owner:stale)fixture.data.deleteAny(PUBLIC,owner.unit(),Node.ANY,Node.ANY);fixture.committed();
            var repaired=scan(fixture,BODY,REALM.getURI(),64);assertEquals(1,repaired.hits().size());assertEquals(valid.unit().getURI(),repaired.hits().getFirst().id());
        }
    }

    private static void copyUnit(Fixture fixture,Owner owner,Node duplicate,Node selection,String body){
        var rows=fixture.data.find(PUBLIC,owner.unit(),Node.ANY,Node.ANY);var facts=new ArrayList<Quad>();
        try{rows.forEachRemaining(facts::add);}finally{org.apache.jena.atlas.iterator.Iter.close(rows);}
        for(var fact:facts)if(!fact.getPredicate().equals(p("searchBody"))&&!fact.getPredicate().equals(p("selection")))
            fixture.data.add(PUBLIC,duplicate,fact.getPredicate(),fact.getObject());
        fixture.data.add(PUBLIC,duplicate,p("selection"),selection);
        fixture.data.add(PUBLIC,duplicate,p("searchBody"),NodeFactory.createLiteralLang(body,"zh-Hant"));
    }
    private static void assertSelectionAmbiguity(Fixture fixture,String phrase,String realm){
        fixture.data.begin(ReadWrite.READ);
        try(var work=new CommandWork()){
            var failure=assertThrows(TextIndexException.class,()->fixture.index.ranked(p("searchBody"),phrase,64,null,new Measured(fixture.data),
                new FilteredGraphTextIndex.RankScope(realm,"zh-Hant",null,true)));
            assertTrue(failure.getMessage(),failure.getMessage().contains("ambiguous"));
            assertEquals(2,count(work,"rank_selection_units_visited"));
            assertTrue(count(work,"rank_live_witnesses_visited")<=128);
        }finally{fixture.data.end();}
    }
    @Test public void selectedOwnerAmbiguityIncludesASecondBodyOutsideThePhraseAndRefusesNamesToo()throws Exception{
        for(boolean realm:List.of(false,true))try(var fixture=new Fixture()){
            var owner=fixture.owner(10000,realm,true,BODY,null);Node duplicate=id(19000);
            copyUnit(fixture,owner,duplicate,owner.selection(),"Only unrelated nonmatching words");fixture.committed();
            // Both copies are current/public, but the second is outside both
            // queried phrases. Text filtering must never conceal its identity.
            assertSelectionAmbiguity(fixture,BODY,realm?REALM.getURI():null);
            assertSelectionAmbiguity(fixture,ALIAS,realm?REALM.getURI():null);
            fixture.data.begin(ReadWrite.WRITE);fixture.data.deleteAny(PUBLIC,duplicate,Node.ANY,Node.ANY);fixture.committed();
            assertEquals(1,scan(fixture,BODY,realm?REALM.getURI():null,64).hits().size());
            assertEquals(1,scan(fixture,ALIAS,realm?REALM.getURI():null,64).hits().size());
        }
    }
    @Test public void duplicateCurrentLanguageHeadsAndRealmHeadsAreRefusedOutsidePhraseFiltering()throws Exception{
        for(boolean realm:List.of(false,true))try(var fixture=new Fixture()){
            var owner=fixture.owner(10000,realm,true,BODY,null);Node secondSelection=id(19000),duplicate=id(19001);
            var rows=fixture.data.find(REVISIONS,owner.selection(),Node.ANY,Node.ANY);var facts=new ArrayList<Quad>();
            try{rows.forEachRemaining(facts::add);}finally{org.apache.jena.atlas.iterator.Iter.close(rows);}
            for(var fact:facts)fixture.data.add(REVISIONS,secondSelection,fact.getPredicate(),fact.getObject());
            set(fixture.data,REVISIONS,secondSelection,"language",NodeFactory.createLiteralString("zh-hant"));
            fixture.data.add(CURRENT,owner.slot(),p("selectionHead"),secondSelection);
            copyUnit(fixture,owner,duplicate,secondSelection,"Only unrelated nonmatching words");fixture.committed();
            for(String phrase:List.of(BODY,ALIAS)){
                fixture.data.begin(ReadWrite.READ);
                try{assertThrows(TextIndexException.class,()->fixture.index.ranked(p("searchBody"),phrase,64,null,new Measured(fixture.data),
                    new FilteredGraphTextIndex.RankScope(realm?REALM.getURI():null,"zh-Hant",null,true)));}finally{fixture.data.end();}
            }
        }
    }
    @Test public void bodyAndNameWitnessesRequireTheSameExactSelectedRevisionContributionAndLanguage()throws Exception{
        for(String mismatch:List.of("contribution","revision","language"))try(var fixture=new Fixture()){
            var owner=fixture.owner(10000,true,true,BODY,null);
            Node value=mismatch.equals("language")?NodeFactory.createLiteralString("en"):id(19000);
            set(fixture.data,PUBLIC,owner.unit(),mismatch,value);fixture.committed();
            assertTrue(mismatch,scan(fixture,BODY,REALM.getURI(),64).hits().isEmpty());
            assertTrue(mismatch,scan(fixture,ALIAS,REALM.getURI(),64).hits().isEmpty());
        }
    }
    @Test public void observedLuceneCollectionWorkIsDistinctFromReturnedWitnessAndRdfBounds()throws Exception{
        long previous=0;
        for(int population:List.of(20,600))try(var fixture=new Fixture()){
            for(int i=0;i<population;i++)fixture.owner(10000+i*10,true,false,BODY,null);
            fixture.committed();fixture.data.begin(ReadWrite.READ);
            try(var work=new CommandWork()){
                var page=fixture.index.ranked(p("searchBody"),BODY,1,null,new Measured(fixture.data),new FilteredGraphTextIndex.RankScope(REALM.getURI(),"zh-Hant",null,true));
                assertEquals(1,page.hits().size());assertTrue(count(work,"rank_live_witnesses_visited")<=128);
                long collections=count(work,"rank_lucene_collection_events");assertTrue(collections>previous);previous=collections;
                assertTrue("actual scoring must be observed",count(work,"rank_lucene_score_calls")>0);
                System.out.println("lucene matching="+population+" returned="+page.hits().size()+" ownerWitnesses="+count(work,"rank_live_witnesses_visited")
                    +" observedCollectionEvents="+collections+" scoreCalls="+count(work,"rank_lucene_score_calls")
                    +" iteratorNextCalls="+count(work,"rank_lucene_iterator_next_calls")+" iteratorAdvanceCalls="+count(work,"rank_lucene_iterator_advance_calls"));
            }finally{fixture.data.end();}
        }
    }

}
