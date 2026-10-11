package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Source names become public candidates only through current Work credits. */
public class SourceAuthorNameProjectionTest {
    private static final Node CURRENT=NodeFactory.createURI(CommandPolicy.CURRENT), REVISIONS=NodeFactory.createURI(CommandPolicy.REVISIONS), CONTROL=NodeFactory.createURI(CommandPolicy.CONTROL), PRODUCT=NodeFactory.createURI("urn:rezics:dataset:product");
    private static Node p(String name){return NodeFactory.createURI("https://rezics.com/vocab/"+name);}
    private static Node id(int n){return NodeFactory.createURI(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d",n));}
    private static Node literal(String value){return NodeFactory.createLiteralString(value);}
    private static Node externalCredit(PrefixWalkTest.Fixture fixture,PrefixWalkTest.Owner owner,int n,String key){
        Node credit=id(n),revision=id(n+1);
        fixture.data.add(CURRENT,credit,RDF.type.asNode(),p("AuthorCredit"));
        for(var entry:Map.of("work",owner.work(),"creditRevision",revision,"externalProvider",literal("open-library"),"externalNamespace",literal("author"),"externalKey",literal(key)).entrySet())fixture.data.add(CURRENT,credit,p(entry.getKey()),entry.getValue());
        fixture.data.add(CURRENT,credit,NodeFactory.createURI("https://schema.org/roleName"),literal("author"));
        fixture.data.add(REVISIONS,revision,RDF.type.asNode(),p("AuthorCreditRevision"));fixture.data.add(REVISIONS,revision,p("component"),credit);
        for(var entry:Map.of("work",owner.work(),"externalProvider",literal("open-library"),"externalNamespace",literal("author"),"externalKey",literal(key)).entrySet())fixture.data.add(REVISIONS,revision,p(entry.getKey()),entry.getValue());
        fixture.data.add(REVISIONS,revision,NodeFactory.createURI("https://schema.org/roleName"),literal("author"));
        return credit;
    }
    private static JsonObject name(String key,String displayName,String language){
        var name=new JsonObject();name.put("sourceKey",key);name.put("displayName",displayName);
        if(language==null)name.put("language",JsonNull.instance);else name.put("language",language);return name;
    }
    private static JsonObject request(Node target,Node credit,String position,String idempotencyKey,JsonObject... names){
        var request=new JsonObject();request.put("target",target.getURI());request.put("sourceKey",names.length==0?"/authors/OL1A":value(names[0],"sourceKey"));request.put("sourcePosition",position);request.put("idempotencyKey",idempotencyKey);var array=new JsonArray();for(var name:names)array.add(name);request.put("names",array);var credits=new JsonArray();credits.add(credit.getURI());request.put("credits",credits);return request;
    }
    private static JsonObject publish(PrefixWalkTest.Fixture fixture,JsonObject request){
        fixture.data.begin(ReadWrite.WRITE);
        try(var work=new CommandWork()){var result=SourceAuthorNameProjection.publish(fixture.data,request,Long.MAX_VALUE);fixture.data.commit();return result;}
        catch(RuntimeException failure){fixture.data.abort();throw failure;}
        finally{fixture.data.end();}
    }
    private static List<JsonObject> accepted(PrefixWalkTest.Fixture fixture,String prefix,String language){
        var result=new ArrayList<JsonObject>();String cursor=null;int pages=0;
        do{
            fixture.data.begin(ReadWrite.READ);JsonObject page;
            try{page=fixture.index.prefixWalk(prefix,language,10,cursor,fixture.data);}finally{fixture.data.end();}
            for(var value:page.get("entries").getAsArray()){var entry=value.getAsObject();if(!entry.get("rejected").getAsBoolean().value())result.add(entry);}
            cursor=page.get("cursor").isNull()?null:page.get("cursor").getAsString().value();
            assertTrue("prefix did not terminate",++pages<1000);
        }while(cursor!=null);
        return result;
    }
    private static Set<Quad> snapshot(PrefixWalkTest.Fixture fixture){
        fixture.data.begin(ReadWrite.READ);try{var result=new HashSet<Quad>();var rows=fixture.data.find();try{while(rows.hasNext())result.add(rows.next());}finally{org.apache.jena.atlas.iterator.Iter.close(rows);}return result;}finally{fixture.data.end();}
    }
    private static String key(Node main,Node unit){return "1"+main.getURI().substring("https://rezics.com/id/".length()).replace("-","")+unit.getURI().substring("https://rezics.com/id/".length()).replace("-","");}
    private static String value(JsonObject object,String field){return object.get(field).getAsString().value();}
    private static long number(JsonObject object,String field){return object.get(field).getAsNumber().value().longValue();}
    private static long counter(String counters,String name){var match=java.util.regex.Pattern.compile("(?:^|,)"+name+"=([0-9]+)").matcher(counters);return match.find()?Long.parseLong(match.group(1)):0;}
    private static void set(DatasetGraph data,Node graph,Node subject,Node predicate,Node value){data.deleteAny(graph,subject,predicate,Node.ANY);data.add(graph,subject,predicate,value);}
    @Test public void sourceNamesNormalizeLikeMainAndUseTheFixedCreditDirectoryKey(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();
            publish(fixture,request(owner.work(),id(9000),"1","author-name-one",name("/authors/OL1A","  E\u0301LODIE\u00a0  Writer  ",null)));
            for(String prefix:List.of("\u00e9","\u00e9lo","writer")){
                var rows=accepted(fixture,prefix,"en");assertEquals(prefix,1,rows.size());assertEquals("credit",value(rows.getFirst(),"matchedField"));assertEquals(key(owner.main(),owner.unit()),value(rows.getFirst(),"key"));
            }
            assertEquals(1,accepted(fixture,"\u00e9lo",null).size());assertTrue(accepted(fixture,"elo","en").isEmpty());assertTrue(accepted(fixture,"\u00e9lo","fr").isEmpty());
        }
    }
    @Test public void replacingAndRemovingNamesUpdatesTheSameSelectedUnit(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();
            publish(fixture,request(owner.work(),id(9000),"1","source-first",name("/authors/OL1A","Book Author","en")));assertEquals(1,accepted(fixture,"bo","en").size());
            publish(fixture,request(owner.main(),id(9000),"2","source-replace",name("/authors/OL1A","Zebra Author","en")));assertTrue(accepted(fixture,"bo","en").isEmpty());assertEquals(1,accepted(fixture,"ze","en").size());
            publish(fixture,request(owner.work(),id(9000),"3","source-remove"));assertTrue(accepted(fixture,"ze","en").isEmpty());
        }
    }
    @Test public void oneAuthorRemovalPreservesOtherAuthorSnapshotsOnTheWork(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");externalCredit(fixture,owner,9010,"/authors/OL2A");fixture.committed();
            publish(fixture,request(owner.work(),id(9000),"10","first-author",name("/authors/OL1A","Book Author",null)));
            // Positions belong to an author snapshot, not to all names of a Work.
            publish(fixture,request(owner.work(),id(9010),"1","second-author",name("/authors/OL2A","Zebra Author",null)));assertEquals(1,accepted(fixture,"bo","en").size());assertEquals(1,accepted(fixture,"ze","en").size());
            publish(fixture,request(owner.work(),id(9000),"11","remove-first-author"));assertTrue(accepted(fixture,"bo","en").isEmpty());assertEquals(1,accepted(fixture,"ze","en").size());
        }
    }
    @Test public void workSourceFactsRemainWhenTheCurrentMainAdvancesAndAfterRebuild(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var original=fixture.owner(1000,"Unrelated original title","en");externalCredit(fixture,original,9000,"/authors/OL1A");fixture.committed();publish(fixture,request(original.work(),id(9000),"1","source-before-main",name("/authors/OL1A","Book Author",null)));
            fixture.data.begin(ReadWrite.WRITE);var next=fixture.owner(10000,"Unrelated next title","en");
            fixture.data.deleteAny(CURRENT,next.work(),Node.ANY,Node.ANY);
            set(fixture.data,CURRENT,original.work(),p("mainVersion"),next.main());set(fixture.data,CURRENT,next.main(),p("work"),original.work());set(fixture.data,CURRENT,next.contribution(),p("work"),original.work());
            set(fixture.data,REVISIONS,next.selection(),p("work"),original.work());set(fixture.data,REVISIONS,next.decision(),p("work"),original.work());set(fixture.data,NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH),next.unit(),p("work"),original.work());
            PublicNameProjection.refresh(fixture.data,original.work());fixture.committed();
            var advanced=accepted(fixture,"bo","en");assertEquals(1,advanced.size());assertEquals(key(next.main(),next.unit()),value(advanced.getFirst(),"key"));
            var current=snapshot(fixture);assertThrows(SourceAuthorNameProjection.ConflictException.class,()->publish(fixture,request(original.main(),id(9000),"2","stale-main-packet",name("/authors/OL1A","Zebra Author",null))));assertEquals(current,snapshot(fixture));
            fixture.data.begin(ReadWrite.WRITE);PublicNameProjection.rebuildPrefix(fixture.data);fixture.committed();
            var rebuilt=accepted(fixture,"bo","en");assertEquals(1,rebuilt.size());assertEquals(key(next.main(),next.unit()),value(rebuilt.getFirst(),"key"));
        }
    }
    @Test public void sourceFactsCanWaitForAMainAndAppearAfterItsSelectionBecomesCurrent(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated pending title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.data.deleteAny(CURRENT,owner.work(),p("mainVersion"),Node.ANY);fixture.committed();
            var result=publish(fixture,request(owner.work(),id(9000),"1","source-pending-main",name("/authors/OL1A","Book Author",null)));assertTrue(result.toString(),result.get("mainVersion").isNull());assertTrue(accepted(fixture,"bo","en").isEmpty());
            fixture.data.begin(ReadWrite.WRITE);fixture.data.add(CURRENT,owner.work(),p("mainVersion"),owner.main());PublicNameProjection.refresh(fixture.data,owner.work());fixture.committed();
            var selected=accepted(fixture,"bo","en");assertEquals(1,selected.size());assertEquals(key(owner.main(),owner.unit()),value(selected.getFirst(),"key"));
        }
    }
    @Test public void replayCannotRewriteCommittedNamesAndOlderPositionsCannotMoveThemBack(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();
            var first=request(owner.work(),id(9000),"10","source-idempotent",name("/authors/OL1A","Book Author",null));publish(fixture,first);var before=snapshot(fixture);
            var replay=publish(fixture,first);assertTrue(replay.get("replayed").getAsBoolean().value());assertEquals(before,snapshot(fixture));
            assertThrows(SourceAuthorNameProjection.ConflictException.class,()->publish(fixture,request(owner.work(),id(9000),"10","source-idempotent",name("/authors/OL1A","Changed Author",null))));assertEquals(before,snapshot(fixture));
            assertThrows(SourceAuthorNameProjection.ConflictException.class,()->publish(fixture,request(owner.work(),id(9000),"9","source-older",name("/authors/OL1A","Older Author",null))));assertEquals(before,snapshot(fixture));
            assertEquals(1,accepted(fixture,"bo","en").size());assertTrue(accepted(fixture,"ch","en").isEmpty());
        }
    }
    @Test public void retiredCreditCannotContinuePublishingAStoredSourceName(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");Node credit=externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();
            publish(fixture,request(owner.work(),id(9000),"1","source-live",name("/authors/OL1A","Book Author",null)));assertEquals(1,accepted(fixture,"bo","en").size());
            fixture.data.begin(ReadWrite.WRITE);fixture.data.add(CURRENT,credit,p("retiredBy"),id(9990));PublicNameProjection.refresh(fixture.data,credit);fixture.committed();
            assertTrue(accepted(fixture,"bo","en").isEmpty());
            var retired=snapshot(fixture);assertThrows(SourceAuthorNameProjection.ConflictException.class,()->publish(fixture,request(owner.work(),id(9000),"2","source-retired",name("/authors/OL1A","Zebra Author",null))));assertEquals(retired,snapshot(fixture));assertTrue(accepted(fixture,"ze","en").isEmpty());
        }
    }
    @Test public void delayedSamePositionPublicationCannotDropAnAdditionalLiveCreditWitness(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");Node firstCredit=externalCredit(fixture,owner,9000,"/authors/OL1A"),secondCredit=externalCredit(fixture,owner,9010,"/authors/OL1A");fixture.committed();
            publish(fixture,request(owner.work(),firstCredit,"1","witness-first",name("/authors/OL1A","Book Author",null)));
            var expanded=request(owner.work(),firstCredit,"1","witness-expanded",name("/authors/OL1A","Book Author",null));var credits=new JsonArray();credits.add(firstCredit.getURI());credits.add(secondCredit.getURI());expanded.put("credits",credits);publish(fixture,expanded);
            // This request began before the second witness was added, but has
            // not previously reached the native idempotency boundary.
            publish(fixture,request(owner.work(),firstCredit,"1","witness-delayed",name("/authors/OL1A","Book Author",null)));
            fixture.data.begin(ReadWrite.WRITE);fixture.data.add(CURRENT,firstCredit,p("retiredBy"),id(9990));PublicNameProjection.refresh(fixture.data,firstCredit);fixture.committed();
            var rows=accepted(fixture,"bo","en");assertEquals(1,rows.size());assertEquals(key(owner.main(),owner.unit()),value(rows.getFirst(),"key"));
        }
    }
    @Test public void retiredAuthorSnapshotsReleaseCapacityWithoutLosingSourcePositionOrdering(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");Node firstCredit=externalCredit(fixture,owner,9000,"/authors/OL1A"),secondCredit=externalCredit(fixture,owner,9010,"/authors/OL2A");fixture.committed();
            JsonObject[] priorNames=new JsonObject[192];for(int i=0;i<priorNames.length;i++)priorNames[i]=name("/authors/OL1A","Retired alias "+i,null);
            publish(fixture,request(owner.work(),firstCredit,"10","capacity-original",priorNames));assertEquals(1,accepted(fixture,"retired","en").size());
            fixture.data.begin(ReadWrite.WRITE);fixture.data.add(CURRENT,firstCredit,p("retiredBy"),id(9990));PublicNameProjection.refresh(fixture.data,firstCredit);fixture.committed();assertTrue(accepted(fixture,"retired","en").isEmpty());
            publish(fixture,request(owner.work(),secondCredit,"1","capacity-new-author",name("/authors/OL2A","Book Author",null)));assertEquals(1,accepted(fixture,"bo","en").size());
            var pruned=snapshot(fixture);var replay=publish(fixture,request(owner.work(),firstCredit,"10","capacity-original",priorNames));assertTrue(replay.get("replayed").getAsBoolean().value());assertEquals(0,number(replay,"examined"));assertEquals(pruned,snapshot(fixture));assertTrue(accepted(fixture,"retired","en").isEmpty());
            // Restore current witness evidence so an older packet must fail
            // for its source position, independently of credit retirement.
            fixture.data.begin(ReadWrite.WRITE);fixture.data.deleteAny(CURRENT,firstCredit,p("retiredBy"),Node.ANY);fixture.committed();var before=snapshot(fixture);
            var stale=assertThrows(SourceAuthorNameProjection.ConflictException.class,()->publish(fixture,request(owner.work(),firstCredit,"0","capacity-old-position",priorNames)));assertTrue(stale.getMessage(),stale.getMessage().contains("position"));assertEquals(before,snapshot(fixture));assertEquals(1,accepted(fixture,"bo","en").size());
        }
    }
    @Test public void creditsWithTheSameNameRemainSortedByMainAndUnitAcrossPages(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            PrefixWalkTest.Owner higher=fixture.owner(2000,"Unrelated higher title","en"),lower=fixture.owner(1000,"Unrelated lower title","en");externalCredit(fixture,higher,9000,"/authors/OL1A");externalCredit(fixture,lower,9010,"/authors/OL2A");fixture.committed();
            publish(fixture,request(higher.work(),id(9000),"1","higher-source",name("/authors/OL1A","Book Author",null)));publish(fixture,request(lower.work(),id(9010),"1","lower-source",name("/authors/OL2A","Book Author",null)));
            assertEquals(List.of(key(lower.main(),lower.unit()),key(higher.main(),higher.unit())),accepted(fixture,"bo","en").stream().map(entry->value(entry,"key")).toList());
        }
    }
    @Test public void abortAndDeadlineFailurePreserveTheLastCommittedName(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();publish(fixture,request(owner.work(),id(9000),"1","source-initial",name("/authors/OL1A","Book Author",null)));var before=snapshot(fixture);
            fixture.data.begin(ReadWrite.WRITE);SourceAuthorNameProjection.publish(fixture.data,request(owner.work(),id(9000),"2","source-aborted",name("/authors/OL1A","Zebra Author",null)),Long.MAX_VALUE);fixture.data.abort();fixture.data.end();
            assertEquals(before,snapshot(fixture));assertEquals(1,accepted(fixture,"bo","en").size());assertTrue(accepted(fixture,"ze","en").isEmpty());
            fixture.data.begin(ReadWrite.WRITE);try{assertThrows(java.util.concurrent.CancellationException.class,()->SourceAuthorNameProjection.publish(fixture.data,request(owner.work(),id(9000),"2","source-deadline",name("/authors/OL1A","Zebra Author",null)),0));}finally{fixture.data.abort();fixture.data.end();}
            assertEquals(before,snapshot(fixture));
        }
    }
    @Test public void malformedScopesAndOverBoundRecipesAreRefusedWithoutMutation(){
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");fixture.committed();var before=snapshot(fixture);
            var invalid=request(owner.work(),id(9000),"1","wrong-source",name("/authors/OL1A","Book Author",null));invalid.put("sourceKey","/authors/OL2A");assertThrows(IllegalArgumentException.class,()->publish(fixture,invalid));
            assertThrows(IllegalArgumentException.class,()->publish(fixture,request(owner.work(),id(9000),"01","bad-position",name("/authors/OL1A","Book Author",null))));
            assertThrows(IllegalArgumentException.class,()->publish(fixture,request(owner.work(),id(9000),"1","k".repeat(129),name("/authors/OL1A","Book Author",null))));
            assertThrows(IllegalArgumentException.class,()->publish(fixture,request(owner.work(),id(9000),"1","bad-name",name("/authors/OL1A","x".repeat(201),null))));
            JsonObject[] names=new JsonObject[193];for(int i=0;i<names.length;i++)names[i]=name("/authors/OL1A","Book alias "+i,null);
            assertThrows(IllegalArgumentException.class,()->publish(fixture,request(owner.work(),id(9000),"1","over-bound",names)));assertEquals(before,snapshot(fixture));
        }
    }
    private static void control(PrefixWalkTest.Fixture fixture){
        fixture.data.add(CONTROL,PRODUCT,p("dataEpoch"),literal("00000000-0000-4000-8000-000000000002"));fixture.data.add(CONTROL,PRODUCT,p("routingEpoch"),literal("routing"));fixture.data.add(CONTROL,PRODUCT,p("sequence"),NodeFactory.createLiteralByValue(java.math.BigInteger.ZERO,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));fixture.data.add(CONTROL,PRODUCT,p("textIndexGeneration"),NodeFactory.createURI("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
        SearchDeltaJournal.initialize(fixture.data);
    }
    private static JsonObject envelope(JsonObject request){var body=new JsonObject();body.put("sourceAuthorNames",request);return body;}
    private static java.net.http.HttpResponse<String> post(int port,JsonObject request,String token)throws Exception{
        var body=envelope(request);var http=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/data/command")).header("Content-Type","application/json").header("Authorization","Bearer "+token).timeout(java.time.Duration.ofSeconds(10)).POST(java.net.http.HttpRequest.BodyPublishers.ofString(body.toString())).build();return java.net.http.HttpClient.newHttpClient().send(http,java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    private static JsonObject health(int port)throws Exception{
        var http=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/data/command")).GET().build();var response=java.net.http.HttpClient.newHttpClient().send(http,java.net.http.HttpResponse.BodyHandlers.ofString());assertEquals(200,response.statusCode());return JSON.parse(response.body());
    }
    @Test public void httpSourceWritesFenceEpochsExportVisitsAndReplayWithoutACommit()throws Exception{
        try(var fixture=new PrefixWalkTest.Fixture()){
            var owner=fixture.owner(1000,"Unrelated title","en");externalCredit(fixture,owner,9000,"/authors/OL1A");control(fixture);fixture.committed();
            var service=new CommandService(ProfileRegistry.load(java.nio.file.Path.of("profiles")),"1".repeat(64).getBytes(),"2".repeat(64).getBytes(),"3".repeat(64).getBytes());var operation=org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","command");
            var server=org.apache.jena.fuseki.main.FusekiServer.create().port(0).addDataset("/data",fixture.data).fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty()).registerOperation(operation,service).addEndpoint("/data","command",operation).build().start();
            try{
                int port=server.getPort();var request=request(owner.work(),id(9000),"1","http-source-name",name("/authors/OL1A","Book Author",null));var before=snapshot(fixture);var initial=health(port);
                assertEquals(403,post(port,request,"1".repeat(64)).statusCode());assertEquals(before,snapshot(fixture));
                var response=post(port,request,"2".repeat(64));assertEquals(response.body(),200,response.statusCode());var result=JSON.parse(response.body());assertFalse(result.get("replayed").getAsBoolean().value());String counts=response.headers().firstValue("X-Rezics-Command-Work").orElseThrow();assertTrue("source name visits were omitted: "+counts,counter(counts,"source_author_name_entries_visited")>0);assertEquals(number(result,"examined"),counter(counts,"source_author_name_entries_visited"));assertTrue(counts.contains("durable_commits=1"));
                var after=health(port);assertFalse(after.get("publicSearchWriteActive").getAsBoolean().value());assertTrue(Long.parseLong(value(after,"publicSearchWriteEpoch"))>Long.parseLong(value(initial,"publicSearchWriteEpoch")));assertEquals(1,accepted(fixture,"bo","en").size());
                var committed=snapshot(fixture);var replay=post(port,request,"2".repeat(64));assertEquals(replay.body(),200,replay.statusCode());var replayResult=JSON.parse(replay.body());assertTrue(replayResult.get("replayed").getAsBoolean().value());assertEquals(0,number(replayResult,"examined"));String replayCounts=replay.headers().firstValue("X-Rezics-Command-Work").orElseThrow();assertTrue(replayCounts.contains("durable_commits=0"));assertEquals(0,counter(replayCounts,"source_author_name_entries_visited"));assertEquals(committed,snapshot(fixture));
                var conflict=post(port,request(owner.work(),id(9000),"1","http-source-name",name("/authors/OL1A","Zebra Author",null)),"2".repeat(64));assertEquals(conflict.body(),409,conflict.statusCode());assertEquals(committed,snapshot(fixture));
                var oversized=request(owner.work(),id(9000),"2","x".repeat(128*1024),name("/authors/OL1A","Zebra Author",null));var capped=post(port,oversized,"2".repeat(64));assertEquals(capped.body(),400,capped.statusCode());assertEquals(committed,snapshot(fixture));assertFalse(health(port).get("publicSearchWriteActive").getAsBoolean().value());
            }finally{server.stop();}
        }
    }
}
