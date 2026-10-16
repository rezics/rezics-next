package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.*;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** The dictionary page, including failed owner proofs, owns the read budget. */
public class PrefixWalkTest {
    private static final Node CURRENT=NodeFactory.createURI(CommandPolicy.CURRENT), PUBLIC=NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), REVISIONS=NodeFactory.createURI(CommandPolicy.REVISIONS);
    private static final Node LABEL=NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label");
    private static Node p(String name){return NodeFactory.createURI("https://rezics.com/vocab/"+name);}
    private static Node id(int n){return NodeFactory.createURI(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d",n));}
    private static void set(DatasetGraph data,Node graph,Node subject,Node predicate,Node value){data.deleteAny(graph,subject,predicate,Node.ANY);data.add(graph,subject,predicate,value);}
    record Owner(Node work,Node main,Node unit,Node selection,Node contribution,Node decision,Node draft){}
    static final class Fixture implements AutoCloseable {
        final FilteredGraphTextIndex index; final DatasetGraphText data; boolean project=true;
        Fixture(){
            var definition=new EntityDefinition("uri","label","graph");definition.set("body",p("searchBody"));definition.set("publicTitle",p("publicTitle"));definition.set("label",LABEL);definition.setLangField("lang");definition.setUidField("uid");
            var config=new TextIndexConfig(definition);config.setValueStored(true);
            index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
            data=new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),index,new TextDocProducerTriples(index));index.bindRankData(data);
            data.begin(ReadWrite.WRITE);
            PublicNameProjection.rebuildPrefix(data);
        }
        Owner owner(int n,String title,String language){
            var owner=new Owner(id(n),id(n+1),id(n+6),id(n+2),id(n+3),id(n+4),id(n+5));
            data.add(CURRENT,owner.work(),RDF.type.asNode(),NodeFactory.createURI("https://schema.org/CreativeWork"));
            data.add(CURRENT,owner.work(),p("mainVersion"),owner.main());data.add(CURRENT,owner.work(),p("head"),id(n+8));
            data.add(CURRENT,owner.work(),LABEL,NodeFactory.createLiteralLang(title,language));
            data.add(CURRENT,owner.main(),RDF.type.asNode(),p("MainVersion"));data.add(CURRENT,owner.main(),p("work"),owner.work());
            data.add(CURRENT,owner.main(),p("selectionHead"),owner.selection());
            data.add(CURRENT,owner.contribution(),p("work"),owner.work());data.add(CURRENT,owner.contribution(),p("publicationHead"),owner.decision());
            data.add(REVISIONS,owner.selection(),RDF.type.asNode(),p("PublicationSelection"));
            data.add(REVISIONS,owner.selection(),p("matchUnit"),owner.unit());
            for(var entry:Map.of("work",owner.work(),"mainVersion",owner.main(),"context",owner.main(),"contribution",owner.contribution(),"publicationDecision",owner.decision(),"selectedDraft",owner.draft(),"language",NodeFactory.createLiteralString(language)).entrySet())data.add(REVISIONS,owner.selection(),p(entry.getKey()),entry.getValue());
            data.add(REVISIONS,owner.decision(),RDF.type.asNode(),p("PublicationDecision"));
            for(var entry:Map.of("component",owner.contribution(),"work",owner.work(),"contribution",owner.contribution(),"selectedDraft",owner.draft(),"disclosure",p("Public")).entrySet())data.add(REVISIONS,owner.decision(),p(entry.getKey()),entry.getValue());
            data.add(REVISIONS,owner.draft(),RDF.type.asNode(),p("RevisionAnchor"));data.add(REVISIONS,owner.draft(),p("component"),owner.contribution());
            unit(owner,owner.unit(),language);
            return owner;
        }
        void unit(Owner owner,Node unit,String language){
            data.add(PUBLIC,unit,RDF.type.asNode(),p("MatchUnit"));
            for(var entry:Map.of("work",owner.work(),"mainVersion",owner.main(),"context",owner.main(),"selection",owner.selection(),"contribution",owner.contribution(),"revision",owner.draft(),"language",NodeFactory.createLiteralString(language),"disclosure",p("Public")).entrySet())data.add(PUBLIC,unit,p(entry.getKey()),entry.getValue());
            data.add(PUBLIC,unit,p("searchBody"),NodeFactory.createLiteralLang("selected public text",language));
            if(project)PublicNameProjection.refreshPrefixUnit(data,unit);
        }
        void credit(Owner owner,int n,String name){
            Node credit=id(n),revision=id(n+1),agent=id(n+2),head=id(n+3);
            data.add(CURRENT,credit,RDF.type.asNode(),p("NativeAgentCredit"));data.add(CURRENT,credit,p("work"),owner.work());data.add(CURRENT,credit,p("creditRevision"),revision);data.add(CURRENT,credit,p("agent"),agent);data.add(CURRENT,credit,NodeFactory.createURI("https://schema.org/roleName"),NodeFactory.createLiteralString("author"));
            data.add(REVISIONS,revision,RDF.type.asNode(),p("NativeAgentCreditRevision"));data.add(REVISIONS,revision,p("component"),credit);data.add(REVISIONS,revision,p("agent"),agent);
            data.add(CURRENT,agent,RDF.type.asNode(),p("Agent"));data.add(CURRENT,agent,p("head"),head);data.add(CURRENT,agent,p("agentKind"),p("PersonAgent"));data.add(CURRENT,agent,p("profileDisclosure"),p("Public"));data.add(CURRENT,agent,LABEL,NodeFactory.createLiteralLang(name,"en"));
            data.add(REVISIONS,head,RDF.type.asNode(),p("RevisionAnchor"));data.add(REVISIONS,head,p("component"),agent);data.add(REVISIONS,head,p("modelRevision"),NodeFactory.createURI("https://rezics.com/definition/agent-provision-v1"));
            PublicNameProjection.refreshPrefixUnit(data,owner.unit());
        }
        void committed(){data.commit();data.end();}
        @Override public void close(){SearchDeltaJournal.stopRecovery(data);if(data.isInTransaction()){data.abort();data.end();}data.close();}
    }
    private static final class Measured extends DatasetGraphWrapper {
        long rows;
        Measured(DatasetGraph data){super(data);}
        @Override public Iterator<Quad> find(Node graph,Node subject,Node predicate,Node object){
            if(Node.ANY.equals(subject))throw new AssertionError("prefix read enumerated a population: "+predicate);
            return org.apache.jena.util.iterator.WrappedIterator.create(super.find(graph,subject,predicate,object)).mapWith(quad->{rows++;return quad;});
        }
    }
    private static long count(CommandWork work,String name){var match=java.util.regex.Pattern.compile("(?:^|,)"+name+"=([0-9]+)").matcher(work.counters());return match.find()?Long.parseLong(match.group(1)):0;}
    private static int number(JsonObject value,String name){return value.get(name).getAsNumber().value().intValue();}
    private static String string(JsonObject value,String name){return value.get(name).getAsString().value();}
    private static boolean bool(JsonObject value,String name){return value.get(name).getAsBoolean().value();}
    private static String cursor(JsonObject page){return page.get("cursor").isNull()?null:string(page,"cursor");}
    private static String key(String field,Node main,Node unit){return (field.equals("title")?"0":"1")+main.getURI().substring("https://rezics.com/id/".length()).replace("-","")+unit.getURI().substring("https://rezics.com/id/".length()).replace("-","");}
    private static JsonObject read(Fixture fixture,String prefix,String language,int size,String after){
        fixture.data.begin(ReadWrite.READ);try{return fixture.index.prefixWalk(prefix,language,size,after,fixture.data);}finally{fixture.data.end();}
    }
    private static List<JsonObject> walk(Fixture fixture,String prefix,String language,int size){
        var all=new ArrayList<JsonObject>();String after=null;var seen=new HashSet<String>();
        do{
            var page=read(fixture,prefix,language,size,after);assertEquals(page.get("entries").getAsArray().size(),number(page,"examined"));assertTrue(number(page,"examined")<=size);
            for(var item:page.get("entries").getAsArray()){var entry=item.getAsObject();assertTrue("entry repeated",seen.add(string(entry,"key")));all.add(entry);}
            String next=cursor(page);if(bool(page,"more")){assertNotNull(next);assertNotEquals(after,next);}else assertNull(next);after=next;
            assertTrue("walk did not terminate",all.size()<10000);
        }while(after!=null);
        return all;
    }
    @Test public void pageVisitsAndOwnedRdfReadsStayEqualAtTwoPopulationSizes(){
        Long rows=null;
        for(int population:List.of(16,64))try(var fixture=new Fixture()){
            for(int i=0;i<population;i++)fixture.owner(1000+i*10,"Book "+i,"en");
            for(int i=0;i<population;i++)fixture.owner(10000+i*10,"Different "+i,"en");
            fixture.committed();fixture.data.begin(ReadWrite.READ);
            try(var work=new CommandWork()){
                var measured=new Measured(fixture.data);var page=fixture.index.prefixWalk("bo","en",10,null,measured);
                assertEquals(10,number(page,"examined"));assertEquals(0,number(page,"rejected"));assertTrue(bool(page,"more"));
                assertEquals(10,count(work,"typeahead_prefix_entries_visited"));
                assertTrue("RDF work exceeded page bound: "+measured.rows,measured.rows<=10*100);
                if(rows==null)rows=measured.rows;else assertEquals(rows.longValue(),measured.rows);
            }finally{fixture.data.end();}
        }
    }
    @Test public void titleCreditMainAndUnitOrderMatchesDirectoryKeysAcrossPages(){
        try(var fixture=new Fixture()){
            var higher=fixture.owner(2000,"Book two","en");var lower=fixture.owner(1000,"Book one","en");
            fixture.unit(lower,id(1009),"en");fixture.credit(higher,9000,"Book Writer");fixture.credit(lower,9010,"Book Author");PublicNameProjection.refreshPrefixUnit(fixture.data,id(1009));fixture.committed();
            var entries=walk(fixture,"bo","en",2);
            var expected=new ArrayList<>(List.of(key("title",lower.main(),lower.unit()),key("title",lower.main(),id(1009)),key("title",higher.main(),higher.unit()),key("credit",lower.main(),lower.unit()),key("credit",lower.main(),id(1009)),key("credit",higher.main(),higher.unit())));expected.sort(String::compareTo);
            assertEquals(expected,entries.stream().map(entry->string(entry,"key")).toList());
            for(var entry:entries)assertFalse(bool(entry,"rejected"));
        }
    }
    @Test public void rejectedEntryConsumesOneVisitAndAdvancesPastItsKey(){
        try(var fixture=new Fixture()){
            var stale=fixture.owner(1000,"Book stale","en");var live=fixture.owner(2000,"Book live","en");
            // A lagging projected term cannot establish current publication authority.
            fixture.data.deleteAny(CURRENT,stale.main(),p("selectionHead"),Node.ANY);fixture.committed();
            fixture.data.begin(ReadWrite.READ);JsonObject first;
            try(var work=new CommandWork()){
                first=fixture.index.prefixWalk("bo","en",1,null,fixture.data);assertEquals(1,number(first,"examined"));assertEquals(1,number(first,"rejected"));assertEquals(1,count(work,"typeahead_prefix_entries_visited"));
            }finally{fixture.data.end();}
            assertEquals(key("title",stale.main(),stale.unit()),string(first.get("entries").getAsArray().get(0).getAsObject(),"key"));
            var second=read(fixture,"bo","en",1,cursor(first));assertEquals(0,number(second,"rejected"));assertEquals(live.main().getURI(),string(second.get("entries").getAsArray().get(0).getAsObject(),"mainVersion"));assertFalse(bool(second,"more"));
            fixture.data.begin(ReadWrite.READ);try(var work=new CommandWork()){
                assertEquals(0,number(fixture.index.prefixWalk("absent","en",10,null,fixture.data),"examined"));assertEquals(0,count(work,"typeahead_prefix_entries_visited"));
            }finally{fixture.data.end();}
        }
    }
    @Test public void mismatchedRevisionLanguageAndAmbiguousEntryEvidenceCannotQualify(){
        try(var fixture=new Fixture()){
            Owner revision=fixture.owner(1000,"Book revision","en"),language=fixture.owner(2000,"Book language","en"),ambiguous=fixture.owner(3000,"Book ambiguous","en");
            set(fixture.data,PUBLIC,revision.unit(),p("revision"),id(9990));
            set(fixture.data,PUBLIC,language.unit(),p("language"),NodeFactory.createLiteralString("fr"));
            String entry=PublicNameProjection.prefixScope("bo","en")+key("title",ambiguous.main(),ambiguous.unit());
            fixture.data.add(PUBLIC,NodeFactory.createURI(entry),p("prefixMain"),id(9991));fixture.committed();
            var page=read(fixture,"bo","en",10,null);assertEquals(3,number(page,"examined"));assertEquals(3,number(page,"rejected"));assertFalse(bool(page,"more"));
        }
    }
    @Test public void nameChangeRefreshesPrefixAndRefusesStaleOrWrongScopeCursor(){
        try(var fixture=new Fixture()){
            var renamed=fixture.owner(1000,"Book old","en");fixture.owner(2000,"Book other","en");fixture.committed();
            var first=read(fixture,"bo","en",1,null);String after=cursor(first);assertNotNull(after);
            assertThrows(IllegalArgumentException.class,()->read(fixture,"b","en",1,after));assertThrows(IllegalArgumentException.class,()->read(fixture,"bo","fr",1,after));
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,renamed.work(),LABEL,NodeFactory.createLiteralLang("Zebra new","en"));PublicNameProjection.refresh(fixture.data,renamed.work());fixture.committed();
            assertThrows(FilteredGraphTextIndex.RankRestart.class,()->read(fixture,"bo","en",1,after));
            assertTrue(walk(fixture,"bo","en",10).stream().noneMatch(entry->!bool(entry,"rejected")&&string(entry,"mainVersion").equals(renamed.main().getURI())));
            var fresh=walk(fixture,"ze","en",10);assertEquals(1,fresh.size());assertFalse(bool(fresh.getFirst(),"rejected"));assertEquals(renamed.main().getURI(),string(fresh.getFirst(),"mainVersion"));
            assertTrue(walk(fixture,"ze","fr",10).isEmpty());
        }
    }
    @Test public void normalizedWordPrefixesAndAbortedNameChangesPreserveCommittedNames(){
        try(var fixture=new Fixture()){
            var owner=fixture.owner(1000,"The   BOO\u0301K of words","en");fixture.owner(2000,"\u0130".repeat(80),"en");fixture.committed();
            assertEquals(1,walk(fixture,"bo\u00f3","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            assertEquals(1,walk(fixture,"\u0130".repeat(80),"en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,owner.work(),LABEL,NodeFactory.createLiteralLang("Zebra temporary","en"));PublicNameProjection.refresh(fixture.data,owner.work());fixture.data.abort();fixture.data.end();
            assertEquals(1,walk(fixture,"bo\u00f3","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            assertTrue(walk(fixture,"ze","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));
        }
    }
    @Test public void existingSelectedUnitsRebuildBeforeCapabilityBecomesAvailable(){
        try(var fixture=new Fixture()){
            PublicNameProjection.invalidatePrefix(fixture.data);fixture.project=false;fixture.owner(1000,"Book old dataset","en");fixture.owner(2000,"Book second","en");
            assertFalse(PublicNameProjection.prefixWalkAvailable(fixture.data));
            PublicNameProjection.rebuildPrefix(fixture.data);assertTrue(PublicNameProjection.prefixWalkAvailable(fixture.data));fixture.committed();
            var first=walk(fixture,"bo","en",1);assertEquals(2,first.size());assertTrue(first.stream().noneMatch(entry->bool(entry,"rejected")));
            fixture.data.begin(ReadWrite.WRITE);PublicNameProjection.rebuildPrefix(fixture.data);fixture.committed();
            assertEquals(first.stream().map(entry->string(entry,"key")).toList(),walk(fixture,"bo","en",1).stream().map(entry->string(entry,"key")).toList());
        }
    }
    @Test public void creditNamesRefreshWithTheAgentAndWithdrawnNamesAreRejected(){
        try(var fixture=new Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");fixture.credit(owner,9000,"Book Author");fixture.committed();
            var first=walk(fixture,"bo","en",10);assertEquals(1,first.size());assertEquals("credit",string(first.getFirst(),"matchedField"));assertFalse(bool(first.getFirst(),"rejected"));
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,id(9002),LABEL,NodeFactory.createLiteralLang("Zebra Author","en"));PublicNameProjection.refresh(fixture.data,id(9002));fixture.committed();
            assertTrue(walk(fixture,"bo","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));assertEquals(1,walk(fixture,"ze","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,id(9002),p("profileDisclosure"),p("Private"));PublicNameProjection.refresh(fixture.data,id(9002));fixture.committed();
            assertTrue(walk(fixture,"ze","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));
        }
    }
    @Test public void retiredCreditNamesDisappearOnRefreshAndRebuildWithoutWithdrawingTheWork(){
        try(var fixture=new Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");fixture.credit(owner,9000,"Book Author");fixture.committed();
            assertEquals(1,walk(fixture,"bo","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,id(9000),p("retiredBy"),id(9100));
            PublicNameProjection.refresh(fixture.data,id(9000));PublicNameProjection.refresh(fixture.data,id(9000));fixture.committed();
            assertTrue(walk(fixture,"bo","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));
            assertEquals(1,walk(fixture,"un","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            fixture.data.begin(ReadWrite.WRITE);PublicNameProjection.rebuildPrefix(fixture.data);fixture.committed();
            assertTrue(walk(fixture,"bo","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));
        }
    }
    @Test public void rawRenameInvalidatesQualificationUntilTheProjectionRebuilds(){
        try(var fixture=new Fixture()){
            var owner=fixture.owner(1000,"Book original","en");fixture.committed();
            assertEquals(1,walk(fixture,"bo","en",10).stream().filter(entry->!bool(entry,"rejected")).count());
            fixture.data.begin(ReadWrite.WRITE);
            var request=org.apache.jena.update.UpdateFactory.create("WITH <"+CommandPolicy.CURRENT+"> DELETE { <"+owner.work().getURI()+"> <"+LABEL.getURI()+"> ?old } INSERT { <"+owner.work().getURI()+"> <"+LABEL.getURI()+"> \"Zebra raw\"@en } WHERE { <"+owner.work().getURI()+"> <"+LABEL.getURI()+"> ?old }");
            TemplateIndexService.appendRawInvalidations(request);org.apache.jena.update.UpdateAction.execute(request,fixture.data);
            assertFalse(PublicNameProjection.prefixWalkAvailable(fixture.data));fixture.committed();
            fixture.data.begin(ReadWrite.READ);try{assertFalse(PublicNameProjection.prefixWalkAvailable(fixture.data));}finally{fixture.data.end();}
            fixture.data.begin(ReadWrite.WRITE);PublicNameProjection.rebuildPrefix(fixture.data);assertTrue(PublicNameProjection.prefixWalkAvailable(fixture.data));fixture.committed();
            assertTrue(walk(fixture,"bo","en",10).stream().noneMatch(entry->!bool(entry,"rejected")));
            var renamed=walk(fixture,"ze","en",10);assertEquals(1,renamed.size());assertFalse(bool(renamed.getFirst(),"rejected"));assertEquals(owner.main().getURI(),string(renamed.getFirst(),"mainVersion"));
        }
    }
    private static JsonObject envelope(String prefix,String language,int pageSize,String cursor){
        var request=new JsonObject();request.put("prefix",prefix);request.put("pageSize",pageSize);
        request.put("language",language==null?org.apache.jena.atlas.json.JsonNull.instance:new org.apache.jena.atlas.json.JsonString(language));
        request.put("cursor",cursor==null?org.apache.jena.atlas.json.JsonNull.instance:new org.apache.jena.atlas.json.JsonString(cursor));
        var body=new JsonObject();body.put("prefixWalk",request);return body;
    }
    private static java.net.http.HttpResponse<String> post(int port,JsonObject body,String token)throws Exception{
        var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/data/command")).header("Content-Type","application/json").header("Authorization","Bearer "+token).timeout(java.time.Duration.ofSeconds(10)).POST(java.net.http.HttpRequest.BodyPublishers.ofString(body.toString())).build();
        return java.net.http.HttpClient.newHttpClient().send(request,java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    @Test public void closedHttpCommandExportsExactVisitsRejectsInvalidInputAndFencesGeneration()throws Exception{
        try(var fixture=new Fixture()){
            var renamed=fixture.owner(1000,"Book first","en");fixture.owner(2000,"Book second","en");PublicNameProjection.invalidatePrefix(fixture.data);fixture.committed();
            var service=new CommandService(ProfileRegistry.load(java.nio.file.Path.of("profiles")),"1".repeat(64).getBytes(),"2".repeat(64).getBytes(),"3".repeat(64).getBytes());
            var operation=org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","command");
            var server=org.apache.jena.fuseki.main.FusekiServer.create().port(0).addDataset("/data",fixture.data).fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty()).registerOperation(operation,service).addEndpoint("/data","command",operation).build().start();
            try{
                int port=server.getPort();var request=envelope("bo","en",1,null);
                assertEquals(403,post(port,request,"1".repeat(64)).statusCode());
                var unavailable=post(port,request,"2".repeat(64));assertEquals(unavailable.body(),503,unavailable.statusCode());assertEquals("unavailable",string(org.apache.jena.atlas.json.JSON.parse(unavailable.body()),"status"));
                fixture.data.begin(ReadWrite.WRITE);PublicNameProjection.rebuildPrefix(fixture.data);fixture.committed();
                var extra=envelope("bo","en",1,null);extra.put("extra",true);assertEquals(400,post(port,extra,"2".repeat(64)).statusCode());
                assertEquals(400,post(port,envelope("bo","en",11,null),"2".repeat(64)).statusCode());
                assertEquals(400,post(port,envelope("bo","en",1,"malformed"),"2".repeat(64)).statusCode());
                var response=post(port,request,"2".repeat(64));assertEquals(response.body(),200,response.statusCode());var page=org.apache.jena.atlas.json.JSON.parse(response.body());assertEquals(1,number(page,"examined"));
                var counters=response.headers().firstValue("X-Rezics-Command-Work").orElseThrow();assertTrue(counters.contains("typeahead_prefix_entries_visited=1"));assertTrue(counters.contains("durable_commits=0"));
                var empty=post(port,envelope("absent","en",1,null),"2".repeat(64));assertEquals(empty.body(),200,empty.statusCode());assertEquals(0,number(org.apache.jena.atlas.json.JSON.parse(empty.body()),"examined"));assertFalse(empty.headers().firstValue("X-Rezics-Command-Work").orElseThrow().contains("typeahead_prefix_entries_visited=1"));
                var health=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/data/command")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertEquals(200,health.statusCode());assertTrue(bool(org.apache.jena.atlas.json.JSON.parse(health.body()),"prefixWalkAvailable"));
                fixture.data.begin(ReadWrite.WRITE);set(fixture.data,CURRENT,renamed.work(),LABEL,NodeFactory.createLiteralLang("Zebra first","en"));PublicNameProjection.refresh(fixture.data,renamed.work());fixture.committed();
                var stale=post(port,envelope("bo","en",1,cursor(page)),"2".repeat(64));assertEquals(stale.body(),409,stale.statusCode());assertEquals("restart",string(org.apache.jena.atlas.json.JSON.parse(stale.body()),"status"));
            }finally{server.stop();}
        }
    }
    @Test public void anUntrackedWriteEndpointDisablesPrefixHealthAndWalk()throws Exception{
        try(var fixture=new Fixture()){
            fixture.owner(1000,"Book candidate","en");fixture.committed();
            var service=new CommandService(ProfileRegistry.load(java.nio.file.Path.of("profiles")),"1".repeat(64).getBytes(),"2".repeat(64).getBytes(),"3".repeat(64).getBytes());
            var operation=org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","command");
            var server=org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data",fixture.data,true).fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty()).registerOperation(operation,service).addEndpoint("/data","command",operation).build().start();
            try{
                int port=server.getPort();
                var health=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/data/command")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertEquals(200,health.statusCode());assertFalse(bool(org.apache.jena.atlas.json.JSON.parse(health.body()),"prefixWalkAvailable"));
                var response=post(port,envelope("bo","en",1,null),"2".repeat(64));assertEquals(response.body(),503,response.statusCode());assertEquals("unavailable",string(org.apache.jena.atlas.json.JSON.parse(response.body()),"status"));
            }finally{server.stop();}
        }
    }
}
