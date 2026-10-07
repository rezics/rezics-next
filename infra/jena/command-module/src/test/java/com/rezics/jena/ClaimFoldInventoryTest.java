package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Source membership only: neither semantic eligibility nor migration/release authority. */
public class ClaimFoldInventoryTest {
    private static final String RV="https://rezics.com/vocab/", XSD="http://www.w3.org/2001/XMLSchema#",
        EPOCH="inventory-epoch", ROUTING="9", FAMILY="claim-statement-fold-v1", PREFIX="urn:rezics:name-migration:claim-statement-fold:";
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), REVISIONS=uri(CommandPolicy.REVISIONS), CONTROL=uri(CommandPolicy.CONTROL), RECEIPTS=uri(CommandPolicy.RECEIPTS),
        PRODUCT=uri("urn:rezics:dataset:product"), STATE=uri(TemplateIndexService.STATE);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV+value); }
    private static Node id(int value) { return uri("https://rezics.com/id/00000000-0000-4000-8000-%012d".formatted(value)); }
    private static Node claim(int index) { return id(1000+index); }
    private static Node head(int index) { return id(10000+index); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(int value) { return NodeFactory.createLiteralDT(Integer.toString(value),org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch(Exception error) { throw new AssertionError(error); }
    }
    private static Map<String,Object> object(Object... entries) {
        Map<String,Object> result=new LinkedHashMap<>();
        for(int i=0;i<entries.length;i+=2) result.put((String)entries[i],entries[i+1]); return result;
    }
    private static String json(Object value) {
        if(value instanceof String string) return org.apache.jena.atlas.json.JSON.toStringFlat(new org.apache.jena.atlas.json.JsonString(string));
        if(value instanceof List<?> list) return "["+list.stream().map(ClaimFoldInventoryTest::json).collect(java.util.stream.Collectors.joining(","))+"]";
        if(value instanceof Map<?,?> map) return "{"+map.entrySet().stream().map(entry->json(entry.getKey())+":"+json(entry.getValue())).collect(java.util.stream.Collectors.joining(","))+"}";
        return String.valueOf(value);
    }
    private static ClaimFoldInventory.Job job(String name) {
        String map=hash(json(List.of(FAMILY,"https://schema.org/datePublished",id(10).getURI(),id(11).getURI())));
        String marker="urn:rezics:maintenance:claim-statement-fold:"+hash(json(List.of(EPOCH,ROUTING,map,name)));
        String digest=hash(json(List.of(FAMILY,"acquire",EPOCH,ROUTING,object("marker",marker,"mapDigest",map,"job",name))));
        return new ClaimFoldInventory.Job(EPOCH,ROUTING,marker,map,name,PREFIX+"acquire:"+digest);
    }
    private static void add(DatasetGraph data,Node graph,Node subject,Object... fields) {
        for(int i=0;i<fields.length;i+=2) data.add(graph,subject,(Node)fields[i],(Node)fields[i+1]);
    }
    private static void source(DatasetGraph data,Node claim,Node head) {
        add(data,CURRENT,claim,RDF.type.asNode(),p("Claim"),p("referent"),uri("urn:inventory:referent"),p("interpretationContext"),uri("urn:inventory:context"),
            p("propositionPredicate"),uri("https://schema.org/datePublished"),p("claimHead"),head,p("claimState"),p("Active"));
        headWitness(data,claim,head);
    }
    private static void headWitness(DatasetGraph data,Node claim,Node head) {
        add(data,REVISIONS,head,RDF.type.asNode(),p("ClaimRevision"),RDF.type.asNode(),p("RevisionAnchor"),p("component"),claim,
            p("modelRevision"),uri("https://rezics.com/definition/claim-v1"),p("shapeRevision"),uri("https://rezics.com/definition/claim-v1"),
            p("dataEpoch"),text("retained-source-epoch"),p("sequence"),integer(1));
    }
    private record Fixture(DatasetGraph data,ClaimFoldInventory.Job job) implements AutoCloseable {
        @Override public void close() { data.close(); }
    }
    private static Fixture fixture(int population,int unrelated) {
        return fixture(population,unrelated,null);
    }
    private static Fixture fixture(int population,int unrelated,Node preallocated) {
        DatasetGraph data=TDB2Factory.createDataset().asDatasetGraph(); ClaimFoldInventory.Job job=job("inventory-source-a");
        data.begin(ReadWrite.WRITE);
        try {
            add(data,CONTROL,PRODUCT,p("dataEpoch"),text(EPOCH),p("routingEpoch"),text(ROUTING),p("sequence"),integer(100));
            add(data,CONTROL,uri(CommandInvariant.MAIN_STREAM_SCOPE),p("dataEpoch"),text(EPOCH),p("streamSequence"),integer(7),p("legacyThroughSequence"),integer(4));
            if(preallocated!=null) data.add(CURRENT,uri("urn:inventory:early-node-allocation"),p("preallocated"),preallocated);
            for(int i=0;i<population;i++) source(data,claim(i),head(i));
            for(int i=0;i<unrelated;i++) add(data,CURRENT,id(30000+i),RDF.type.asNode(),p("UnrelatedResource"),p("description"),text("unrelated "+i));
            acquire(data,job); data.commit();
        } finally { data.end(); }
        return new Fixture(data,job);
    }
    /** Acquire through the accepted fixed policy, rather than forging an ownership receipt. */
    private static void acquire(DatasetGraph data,ClaimFoldInventory.Job job) {
        String digest=job.acquireReceipt().substring(job.acquireReceipt().lastIndexOf(':')+1);
        String update="PREFIX rv: <"+RV+"> INSERT { GRAPH <"+CommandPolicy.CONTROL+"> { <"+PRODUCT.getURI()+"> rv:restoreHold true . <"+job.marker()
            +"> rv:claimStatementFoldFence true ; rv:foldMapDigest "+json(job.mapDigest())+" . } GRAPH <"+CommandPolicy.RECEIPTS+"> { <"+job.acquireReceipt()
            +"> a rv:OperationReceipt ; rv:commandFamily \"claim-statement-fold-acquire-v1\" ; rv:requestDigest "+json(digest)+" ; rv:outcome rv:Succeeded ; rv:datasetId <"+PRODUCT.getURI()
            +"> ; rv:dataEpoch "+json(EPOCH)+" ; rv:sequence ?sequence ; rv:claimStatementFold <"+job.marker()+"> ; rv:foldMapDigest "+json(job.mapDigest())+" ; rv:claimFoldJob "+json(job.job())
            +" . } } WHERE { GRAPH <"+CommandPolicy.CONTROL+"> { <"+PRODUCT.getURI()+"> rv:dataEpoch "+json(EPOCH)+" ; rv:routingEpoch "+json(ROUTING)+" ; rv:sequence ?sequence . }"
            +" FILTER NOT EXISTS { GRAPH <"+CommandPolicy.CONTROL+"> { <"+PRODUCT.getURI()+"> rv:restoreHold true } } FILTER NOT EXISTS { GRAPH <"+CommandPolicy.RECEIPTS+"> { <"+job.acquireReceipt()+"> ?rp ?ro } } }";
        var request=UpdateFactory.create(update);
        var plan=new CommandPolicy.Plan(request,Set.of(CommandPolicy.CONTROL,CommandPolicy.RECEIPTS),Set.of(),Set.of(),Set.of(),false,false,false);
        var snapshot=ClaimStatementFoldPolicy.capture(data,job.acquireReceipt(),digest,plan); assertNull(snapshot.error());
        ClaimStatementFoldPolicy.applyExact(data,snapshot,plan); assertNull(ClaimStatementFoldPolicy.check(data,snapshot));
        data.add(RECEIPTS,uri(job.acquireReceipt()),ClaimStatementFoldPolicy.templateDigestPredicate(),text(ClaimStatementFoldPolicy.templateDigest(update)));
    }
    private static ClaimFoldInventory.Request request(ClaimFoldInventory.Job job,String attempt,int page,String previous) {
        return new ClaimFoldInventory.Request(job,attempt,page,previous,UUID.randomUUID().toString(),System.currentTimeMillis()+60_000);
    }
    private static Set<Quad> all(DatasetGraph data) {
        data.begin(ReadWrite.READ); try { return new HashSet<>(Iter.toList(data.find())); } finally { data.end(); }
    }
    private static long version(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try { return TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getTxnSystem().getThreadTransaction().getDataVersion(); }
        finally { data.end(); }
    }
    private static boolean sealed(Fixture fixture,ClaimFoldInventory.Result result) {
        fixture.data().begin(ReadWrite.READ);
        try { return ClaimFoldInventory.requireSealed(fixture.data(),fixture.job(),result.sourceCut(),result.hash()); }
        finally { fixture.data().end(); }
    }
    private static boolean registered(Fixture fixture) {
        fixture.data().begin(ReadWrite.READ);
        try { return ClaimFoldInventory.registered(fixture.data(),fixture.job()); }
        finally { fixture.data().end(); }
    }
    /** Count actual prefix tuples, independently of the page size and native counters. */
    private static long[] physical(DatasetGraph data) {
        return physical(data,()->{},()->{});
    }
    private static long[] physical(DatasetGraph data,Runnable claimTuple,Runnable pointFind) {
        var storage=TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data));
        var nodeTable=storage.getQuadTable().getNodeTupleTable().getNodeTable();
        var table=storage.getQuadTable().getNodeTupleTable().getTupleTable(); long[] records={0,0,0,0}; byte[] claimPrefix=new byte[24];
        data.begin(ReadWrite.READ);
        try {
            Node[] prefix={CURRENT,RDF.type.asNode(),p("Claim")};
            for(int i=0;i<3;i++) NodeIdFactory.set(TDBInternal.getNodeId(storage,prefix[i]),claimPrefix,i*8);
        } finally { data.end(); }
        for(String name:List.of("GPOS","GSPO")) {
            var original=table.selectIndex(name); var base=(TupleIndexRecord)original.baseTupleIndex();
            var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
                (proxy,method,args)->{
                    Object result=method.invoke(base.getRangeIndex(),args);
                    if(!method.getName().equals("iterator")) return result;
                    boolean claims=name.equals("GPOS")&&args[0] instanceof org.apache.jena.dboe.base.record.Record start&&Arrays.equals(claimPrefix,Arrays.copyOf(start.getKey(),24));
                    return Iter.map((Iterator<?>)result,row->{records[claims?0:name.equals("GSPO")?1:2]++;if(claims) claimTuple.run();return row;});
                });
            var counted=new TupleIndexRecord(4,original.getMapping(),name,range.getRecordFactory(),range);
            var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},
                (proxy,method,args)->{
                    if(method.getName().equals("baseTupleIndex")) return counted;
                    if(method.getName().equals("find")) pointFind.run();
                    Object result=method.invoke(original,args);
                    return method.getName().equals("find")&&result instanceof Iterator<?>?Iter.map((Iterator<?>)result,row->{
                        records[name.equals("GSPO")?1:2]++;
                        if(name.equals("GSPO")&&row instanceof org.apache.jena.atlas.lib.tuple.Tuple<?> tuple) {
                            Node graph=nodeTable.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(0));
                            Node subject=nodeTable.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(1));
                            boolean currentClaim=graph.equals(CURRENT)&&subject.isURI()&&subject.getURI().startsWith("https://rezics.com/id/")
                                &&Integer.parseInt(subject.getURI().substring(subject.getURI().length()-12))>=1000
                                &&Integer.parseInt(subject.getURI().substring(subject.getURI().length()-12))<10000;
                            if(currentClaim||graph.equals(REVISIONS)) {
                                Node predicate=nodeTable.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(2));
                                Node object=nodeTable.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(3));
                                records[3]+=NodeFmtLib.strNT(predicate).getBytes(StandardCharsets.UTF_8).length+NodeFmtLib.strNT(object).getBytes(StandardCharsets.UTF_8).length;
                            }
                        }
                        return row;
                    }):result;
                });
            for(int i=0;i<table.numIndexes();i++) if(table.getIndex(i)==original) table.setTupleIndex(i,observed);
        }
        return records;
    }
    private static ClaimFoldInventory.Result scan(Fixture fixture,long[] counts,Set<String> seen) {
        String attempt=UUID.randomUUID().toString(),previous=""; int page=0; ClaimFoldInventory.Result result;
        do {
            long tuples=counts[0],points=counts[1],sourceBytes=counts[3];
            result=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,page,previous));
            assertEquals(result.toString(),"committed",result.status()); assertTrue(result.rows().size()<=127);
            assertTrue("type seek exceeded 128 including lookahead: "+(counts[0]-tuples),counts[0]-tuples<=128);
            assertTrue("point reads exceeded fixed page bound: "+(counts[1]-points),counts[1]-points<=2200);
            assertTrue("actual C/head fields exceeded their combined byte allowance: "+(counts[3]-sourceBytes),counts[3]-sourceBytes<=result.rows().size()*2048L);
            assertTrue(result.toString().getBytes(StandardCharsets.UTF_8).length<=256*1024);
            assertTrue(result.hash().matches("[0-9a-f]{64}")); assertTrue(result.sourceCut().matches("[0-9a-f]{64}"));
            for(var row:result.rows()) {
                assertTrue("source C repeated across pages",seen.add(row.claim())); assertTrue(row.witness().matches("[0-9a-f]{64}"));
                int index=Integer.parseInt(row.claim().substring(row.claim().length()-12))-1000; assertEquals(head(index).getURI(),row.head());
            }
            if(!result.sourceComplete()) { assertEquals(127,result.rows().size()); assertFalse(sealed(fixture,result)); }
            previous=result.hash();page++;
            assertTrue("bounded inventory never reached real EOF",page<=40);
        } while(!result.sourceComplete());
        assertTrue(sealed(fixture,result)); return result;
    }
    @Test public void actualTypePrefixExhaustionCovers127128129And3501ClaimsWithoutPopulationSorting() {
        for(int population:List.of(127,128,129,3501)) {
            List<Long> baseline=null;
            for(int unrelated:List.of(0,5000)) try(Fixture fixture=fixture(population,unrelated)) {
                long[] records=physical(fixture.data()); Set<String> seen=new HashSet<>(); var result=scan(fixture,records,seen);
                assertEquals(population,seen.size()); assertEquals(population,result.total());
                assertEquals("lookahead must be counted and replayed only on the next page",population+(population-1)/127,records[0]);
                assertTrue("source bytes were not independently observed",records[3]>0);
                List<Long> cost=List.of(records[0],records[1],records[3]); if(baseline==null) baseline=cost; else assertEquals("unrelated growth inflated source work",baseline,cost);
                System.out.println("claim inventory source="+population+" unrelated="+unrelated+" typeTuples="+records[0]+" pointRows="+records[1]+" sourceBytes="+records[3]+" sourceComplete=true");
            }
        }
    }
    @Test public void lostAcknowledgmentReplaysExactPageWithoutACommitAndCheckpointCasRefusesTampering() {
        try(Fixture fixture=fixture(129,0)) {
            long[] records=physical(fixture.data()); String attempt=UUID.randomUUID().toString(); var request=request(fixture.job(),attempt,0,"");
            var first=ClaimFoldInventory.turn(fixture.data(),request); assertEquals("committed",first.status()); assertFalse(first.sourceComplete());
            Set<Quad> before=all(fixture.data()); long version=version(fixture.data()),tuples=records[0];
            assertEquals(first,ClaimFoldInventory.turn(fixture.data(),request)); assertEquals(version,version(fixture.data()));
            assertEquals(before,all(fixture.data())); assertEquals(tuples,records[0]);
            var changed=new ClaimFoldInventory.Request(request.job(),request.attempt(),request.page(),request.previous(),request.requestId(),request.deadline()+1);
            assertEquals("conflict",ClaimFoldInventory.turn(fixture.data(),changed).status());
            assertEquals("conflict",ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,1,"0".repeat(64))).status());
            assertEquals(before,all(fixture.data()));
            var last=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,1,first.hash()));
            assertEquals("committed",last.status()); assertTrue(last.sourceComplete()); assertEquals(129,last.total()); assertTrue(sealed(fixture,last));
        }
    }
    @Test public void foreignNeutralCommitInvalidatesOnlyPhysicalProgressAndNewAttemptReconcilesLogicalSources() {
        try(Fixture fixture=fixture(129,0)) {
            String attempt=UUID.randomUUID().toString(); var first=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,0,""));
            assertEquals("committed",first.status());
            fixture.data().begin(ReadWrite.WRITE); try { fixture.data().add(CONTROL,uri("urn:inventory:neutral"),p("heartbeat"),text("unchanged source")); fixture.data().commit(); } finally { fixture.data().end(); }
            Set<Quad> before=all(fixture.data()); assertEquals("restart-required",ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,1,first.hash())).status()); assertEquals(before,all(fixture.data()));
            var restarted=scan(fixture,physical(fixture.data()),new HashSet<>());
            assertEquals(129,restarted.total()); assertNotEquals("new attempt has a different explicit source cut",first.sourceCut(),restarted.sourceCut());
        }
    }
    @Test public void changedOrDisappearedPreviouslyVisitedClaimsBlockAReplacementAttemptSeal() {
        for(boolean removed:List.of(false,true)) try(Fixture fixture=fixture(129,0)) {
            var first=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),UUID.randomUUID().toString(),0,"")); assertEquals("committed",first.status());
            fixture.data().begin(ReadWrite.WRITE);
            try { if(removed) fixture.data().deleteAny(CURRENT,claim(0),Node.ANY,Node.ANY); else { fixture.data().deleteAny(CURRENT,claim(0),p("claimHead"),Node.ANY); fixture.data().add(CURRENT,claim(0),p("claimHead"),id(99000)); headWitness(fixture.data(),claim(0),id(99000)); } fixture.data().commit(); }
            finally { fixture.data().end(); }
            String attempt=UUID.randomUUID().toString(),previous=""; ClaimFoldInventory.Result result=null;
            for(int page=0;page<3;page++) {
                Set<Quad> before=all(fixture.data()); result=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,page,previous));
                if(!result.status().equals("committed")) { assertEquals(before,all(fixture.data())); break; }
                assertFalse(result.sourceComplete()); previous=result.hash();
            }
            assertNotNull(result); assertEquals(result.toString(),"invalid",result.status()); assertFalse(result.sourceComplete());
        }
    }
    @Test public void malformedMixedNonportableAndOversizedSourcesRefuseTheWholePage() {
        for(String defect:List.of("extra","missing","literal-head","non-native-head","non-native-claim","default","mixed","oversized")) try(Fixture fixture=fixture(5,0)) {
            DatasetGraph data=fixture.data(); data.begin(ReadWrite.WRITE);
            try {
                switch(defect) {
                    case "extra" -> data.add(CURRENT,claim(0),p("extra"),text("unreviewed"));
                    case "missing" -> data.deleteAny(CURRENT,claim(0),p("referent"),Node.ANY);
                    case "literal-head" -> { data.deleteAny(CURRENT,claim(0),p("claimHead"),Node.ANY); data.add(CURRENT,claim(0),p("claimHead"),text("not a reference")); }
                    case "non-native-head" -> { data.deleteAny(CURRENT,claim(0),p("claimHead"),Node.ANY); data.add(CURRENT,claim(0),p("claimHead"),uri("urn:unportable:head")); }
                    case "non-native-claim" -> source(data,uri("urn:unportable:claim"),head(9));
                    case "default" -> sourceDefault(data);
                    case "mixed" -> { Node value=data.find(CURRENT,claim(0),p("claimHead"),Node.ANY).next().getObject(); data.deleteAny(CURRENT,claim(0),p("claimHead"),Node.ANY); data.add(Quad.defaultGraphNodeGenerated,claim(0),p("claimHead"),value); }
                    case "oversized" -> { data.deleteAny(CURRENT,claim(0),p("referent"),Node.ANY); data.add(CURRENT,claim(0),p("referent"),uri("urn:oversized:"+"x".repeat(4096))); }
                    default -> throw new AssertionError(defect);
                }
                data.commit();
            } finally { data.end(); }
            Set<Quad> before=all(data); var result=ClaimFoldInventory.turn(data,request(fixture.job(),UUID.randomUUID().toString(),0,""));
            assertEquals(defect+": "+result,"invalid",result.status()); assertFalse(result.sourceComplete()); assertFalse(registered(fixture)); assertEquals(before,all(data));
        }
    }
    private static void sourceDefault(DatasetGraph data) { data.add(Quad.defaultGraphNodeGenerated,id(99000),RDF.type.asNode(),p("Claim")); }
    @Test public void copiedPhysicalStoreRequiresANewAttemptInsteadOfReusingNodeIdProgress() {
        try(Fixture original=fixture(129,0)) {
            String attempt=UUID.randomUUID().toString(); var originalRequest=request(original.job(),attempt,0,"");
            var first=ClaimFoldInventory.turn(original.data(),originalRequest);
            Set<Quad> snapshot=all(original.data()); DatasetGraph copy=TDB2Factory.createDataset().asDatasetGraph();
            try(Fixture restored=new Fixture(copy,original.job())) {
                copy.begin(ReadWrite.WRITE);
                try { for(int i=128;i>=0;i--) copy.add(CURRENT,claim(i),p("temporary"),text("allocate reversed physical subjects")); snapshot.forEach(copy::add); copy.deleteAny(CURRENT,Node.ANY,p("temporary"),Node.ANY); copy.commit(); }
                finally { copy.end(); }
                Set<Quad> before=all(copy); assertEquals("restart-required",ClaimFoldInventory.turn(copy,request(restored.job(),attempt,1,first.hash())).status()); assertEquals(before,all(copy));
                assertEquals(first,ClaimFoldInventory.turn(copy,originalRequest));
                var last=scan(restored,physical(copy),new HashSet<>()); assertEquals(129,last.total());
            }
        }
    }
    @Test public void sourceSealGateAndHeldJobProofCannotBeBorrowedAcrossJobsOrExistingConversions() {
        try(Fixture fixture=fixture(129,0)) {
            var first=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),UUID.randomUUID().toString(),0,""));
            assertTrue(registered(fixture)); assertFalse(sealed(fixture,first)); Set<Quad> before=all(fixture.data());
            var wrong=ClaimFoldInventory.turn(fixture.data(),request(job("inventory-source-b"),UUID.randomUUID().toString(),0,""));
            assertEquals("invalid",wrong.status()); assertEquals(before,all(fixture.data()));
        }
        try(Fixture fixture=fixture(1,0)) {
            fixture.data().begin(ReadWrite.WRITE);
            try { add(fixture.data(),RECEIPTS,uri(PREFIX+"convert:"+"a".repeat(64)),RDF.type.asNode(),p("OperationReceipt"),p("claimStatementFold"),uri(fixture.job().marker())); fixture.data().commit(); }
            finally { fixture.data().end(); }
            Set<Quad> before=all(fixture.data()); var result=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),UUID.randomUUID().toString(),0,""));
            assertEquals("invalid",result.status()); assertFalse(registered(fixture)); assertEquals(before,all(fixture.data()));
        }
    }
    @Test public void expiredTurnLeavesNoPrivateRegistrationOrPartialPage() {
        try(Fixture fixture=fixture(129,0)) {
            Set<Quad> before=all(fixture.data()); var request=new ClaimFoldInventory.Request(fixture.job(),UUID.randomUUID().toString(),0,"",UUID.randomUUID().toString(),System.currentTimeMillis()-1);
            assertEquals("deadline",ClaimFoldInventory.turn(fixture.data(),request).status()); assertFalse(registered(fixture)); assertEquals(before,all(fixture.data()));
        }
    }
    @Test public void emptyPrefixSealsOnlyAnEmptySourceAndReplaysWithoutAnEmptyWriteCommit() {
        try(Fixture fixture=fixture(0,0)) {
            long[] records=physical(fixture.data()); var request=request(fixture.job(),UUID.randomUUID().toString(),0,"");
            var result=ClaimFoldInventory.turn(fixture.data(),request);
            assertEquals(result.toString(),"committed",result.status()); assertTrue(result.sourceComplete());
            assertTrue(result.rows().isEmpty()); assertEquals(0,result.total()); assertEquals("",result.next()); assertEquals(0,records[0]);
            assertTrue(registered(fixture)); assertTrue(sealed(fixture,result));
            long version=version(fixture.data()); Set<Quad> before=all(fixture.data());
            assertEquals(result,ClaimFoldInventory.turn(fixture.data(),request)); assertEquals(version,version(fixture.data())); assertEquals(before,all(fixture.data()));
            fixture.data().begin(ReadWrite.READ);
            try { assertFalse(ClaimFoldInventory.requireSealed(fixture.data(),fixture.job(),result.sourceCut(),"0".repeat(64))); }
            finally { fixture.data().end(); }
        }
    }
    @Test public void boundaryHeadAndPrivateJournalCorruptionCannotSealOrReplayAnInventedSourcePage() {
        for(String defect:List.of("head-missing","head-profile","head-default","head-mixed","head-oversized","checkpoint","logical-row","result")) try(Fixture fixture=fixture(129,0)) {
            DatasetGraph data=fixture.data(); String attempt=UUID.randomUUID().toString();
            boolean badHead=defect.startsWith("head-");
            if(badHead) {
                data.begin(ReadWrite.WRITE);
                try {
                    if(defect.equals("head-missing")) data.deleteAny(REVISIONS,head(127),Node.ANY,Node.ANY);
                    else if(defect.equals("head-profile")) { data.deleteAny(REVISIONS,head(127),p("shapeRevision"),Node.ANY); data.add(REVISIONS,head(127),p("shapeRevision"),uri("urn:unreviewed:claim-profile")); }
                    else if(defect.equals("head-default")) for(Quad quad:Iter.toList(data.find(REVISIONS,head(127),Node.ANY,Node.ANY))) { data.delete(quad); data.add(Quad.defaultGraphNodeGenerated,quad.getSubject(),quad.getPredicate(),quad.getObject()); }
                    else if(defect.equals("head-mixed")) { Node value=data.find(REVISIONS,head(127),p("modelRevision"),Node.ANY).next().getObject(); data.deleteAny(REVISIONS,head(127),p("modelRevision"),Node.ANY); data.add(Quad.defaultGraphNodeGenerated,head(127),p("modelRevision"),value); }
                    else { data.deleteAny(REVISIONS,head(127),p("dataEpoch"),Node.ANY); data.add(REVISIONS,head(127),p("dataEpoch"),text("x".repeat(4096))); }
                    data.commit();
                } finally { data.end(); }
            }
            var firstRequest=request(fixture.job(),attempt,0,""); var first=ClaimFoldInventory.turn(data,firstRequest);
            assertEquals(first.toString(),"committed",first.status()); assertEquals(127,first.rows().size()); assertFalse(first.sourceComplete());
            ClaimFoldInventory.Request next=request(fixture.job(),attempt,1,first.hash());
            if(!badHead) {
                data.begin(ReadWrite.WRITE);
                try {
                    if(defect.equals("checkpoint")) {
                        Node header=uri(fixture.job().marker()+":inventory"); data.deleteAny(STATE,header,p("inventoryCheckpoint"),Node.ANY); data.add(STATE,header,p("inventoryCheckpoint"),text("{}"));
                    } else if(defect.equals("logical-row")) {
                        Node row=uri(fixture.job().marker()+":inventory:claim:"+hash(first.rows().getFirst().claim()));
                        data.deleteAny(STATE,row,p("witness"),Node.ANY); data.add(STATE,row,p("witness"),text("0".repeat(64)));
                        next=request(fixture.job(),UUID.randomUUID().toString(),0,"");
                    } else {
                        Node receipt=uri("urn:rezics:claim-inventory-turn:"+firstRequest.requestId());
                        Node retained=data.find(STATE,receipt,p("inventoryResult"),Node.ANY).next().getObject();
                        var forged=org.apache.jena.atlas.json.JSON.parse(retained.getLiteralLexicalForm()); forged.put("sourceComplete",true);
                        data.deleteAny(STATE,receipt,p("inventoryResult"),Node.ANY); data.add(STATE,receipt,p("inventoryResult"),text(org.apache.jena.atlas.json.JSON.toStringFlat(forged)));
                        next=firstRequest;
                    }
                    data.commit();
                } finally { data.end(); }
            }
            Set<Quad> before=all(data); var refused=ClaimFoldInventory.turn(data,next);
            assertEquals(defect+": "+refused,"invalid",refused.status()); assertFalse(refused.sourceComplete());
            assertEquals(before,all(data)); assertFalse(sealed(fixture,first));
        }
    }
    @Test public void oversizedSequenceAndCumulativeHeadBytesAbortAfterTheLookaheadCheckpoint() {
        for(int digits:List.of(8192,1900)) try(Fixture fixture=fixture(129,0)) {
            DatasetGraph data=fixture.data();
            // Seed before the checkpoint: changing it afterwards would test
            // storage-version refusal instead of the scalar/head byte guard.
            data.begin(ReadWrite.WRITE);
            try {
                data.deleteAny(REVISIONS,head(127),p("sequence"),Node.ANY);
                data.add(REVISIONS,head(127),p("sequence"),NodeFactory.createLiteralDT("1".repeat(digits),org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.commit();
            } finally { data.end(); }
            String attempt=UUID.randomUUID().toString();
            var first=ClaimFoldInventory.turn(data,request(fixture.job(),attempt,0,""));
            assertEquals(first.toString(),"committed",first.status()); assertEquals(127,first.rows().size());
            assertEquals(127,first.total()); assertFalse(first.sourceComplete()); assertFalse(sealed(fixture,first));
            Set<Quad> before=all(data); long beforeVersion=version(data);
            var refused=ClaimFoldInventory.turn(data,request(fixture.job(),attempt,1,first.hash()));
            assertEquals("sequence digits="+digits+": "+refused,"invalid",refused.status());
            assertTrue(refused.toString(),refused.error().contains("byte bound")); assertFalse(refused.sourceComplete());
            assertEquals("failed page must preserve checkpoint, witnesses and replay receipts",before,all(data));
            assertEquals("failed byte guard must not commit an empty transaction",beforeVersion,version(data));
            assertFalse(sealed(fixture,first));
            data.begin(ReadWrite.READ);
            try {
                assertTrue(CommandInvariant.readControl(data).held());
                assertTrue(data.contains(CONTROL,uri(fixture.job().marker()),p("claimStatementFoldFence"),NodeFactory.createLiteralDT("true",org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)));
                assertTrue(data.contains(RECEIPTS,uri(fixture.job().acquireReceipt()),p("outcome"),p("Succeeded")));
            } finally { data.end(); }
        }
    }
    @Test public void interruptionAfterTheNativeScanBeginsRollsBackAndKeepsTheCommittedContinuationUsable() {
        try(Fixture fixture=fixture(129,0)) {
            String attempt=UUID.randomUUID().toString(); var first=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,0,""));
            assertEquals("committed",first.status()); Set<Quad> before=all(fixture.data()); long beforeVersion=version(fixture.data());
            var armed=new java.util.concurrent.atomic.AtomicBoolean(true);
            long[] records=physical(fixture.data(),()->{ if(armed.compareAndSet(true,false)) Thread.currentThread().interrupt(); },()->{});
            var next=request(fixture.job(),attempt,1,first.hash()); ClaimFoldInventory.Result refused;
            try { refused=ClaimFoldInventory.turn(fixture.data(),next); }
            finally { Thread.interrupted(); }
            assertTrue("interruption must occur after actual source work starts",records[0]>0);
            assertEquals(refused.toString(),"deadline",refused.status()); assertFalse(refused.sourceComplete());
            assertEquals(before,all(fixture.data())); assertEquals(beforeVersion,version(fixture.data())); assertFalse(sealed(fixture,first));
            var resumed=ClaimFoldInventory.turn(fixture.data(),next);
            assertEquals(resumed.toString(),"committed",resumed.status()); assertTrue(resumed.sourceComplete()); assertEquals(129,resumed.total()); assertTrue(sealed(fixture,resumed));
        }
    }
    private static final class ControlledClock extends java.time.Clock {
        final java.util.concurrent.atomic.AtomicLong now;
        final java.util.concurrent.CountDownLatch entry=new java.util.concurrent.CountDownLatch(1);
        ControlledClock(long now) { this.now=new java.util.concurrent.atomic.AtomicLong(now); }
        @Override public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public java.time.Instant instant() { return java.time.Instant.ofEpochMilli(millis()); }
        @Override public long millis() { entry.countDown(); return now.get(); }
        void advance(long millis) { now.addAndGet(millis); }
    }
    @Test public void blockedWriteAdmissionCannotRenewTheEntryDeadlineAndExpiredHistoryUsesOnlyReadAdmission() throws Exception {
        try(Fixture fixture=fixture(129,0)) {
            String attempt=UUID.randomUUID().toString();
            var original=new ClaimFoldInventory.Request(fixture.job(),attempt,0,"",UUID.randomUUID().toString(),System.currentTimeMillis()+5000);
            var first=ClaimFoldInventory.turn(fixture.data(),original); assertEquals(first.toString(),"committed",first.status());
            Set<Quad> before=all(fixture.data()); long beforeVersion=version(fixture.data());
            var held=new java.util.concurrent.CountDownLatch(1); var release=new java.util.concurrent.CountDownLatch(1);
            var worker=new java.util.concurrent.atomic.AtomicReference<Thread>(); var released=new java.util.concurrent.atomic.AtomicBoolean();
            var postAdmissionReads=new java.util.concurrent.atomic.AtomicInteger();
            physical(fixture.data(),()->{},()->{ if(released.get()&&Thread.currentThread()==worker.get()) postAdmissionReads.incrementAndGet(); });
            var executor=java.util.concurrent.Executors.newFixedThreadPool(3);
            var holder=executor.submit(()->{
                fixture.data().begin(ReadWrite.WRITE); held.countDown();
                try { if(!release.await(15,java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("writer test did not release"); }
                catch(InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
                finally { fixture.data().abort(); fixture.data().end(); }
            });
            try {
                assertTrue(held.await(5,java.util.concurrent.TimeUnit.SECONDS));
                // This request is expired under its clock and a writer is held:
                // historical recovery must still finish without WRITE admission.
                var historical=executor.submit(()->ClaimFoldInventory.turn(fixture.data(),original,new ControlledClock(original.deadline()+1)));
                assertEquals(first,historical.get(2,java.util.concurrent.TimeUnit.SECONDS));
                var clock=new ControlledClock(System.currentTimeMillis());
                var next=new ClaimFoldInventory.Request(fixture.job(),attempt,1,first.hash(),UUID.randomUUID().toString(),Long.MAX_VALUE);
                var pending=executor.submit(()->{ worker.set(Thread.currentThread()); return ClaimFoldInventory.turn(fixture.data(),next,clock); });
                assertTrue("worker entry clock was not observed",clock.entry.await(2,java.util.concurrent.TimeUnit.SECONDS));
                long waitUntil=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2); boolean blocked=false;
                while(System.nanoTime()<waitUntil) {
                    Thread thread=worker.get();
                    if(thread!=null&&thread.getState()==Thread.State.WAITING&&Arrays.stream(thread.getStackTrace()).anyMatch(frame->frame.getClassName().contains(".transaction."))) { blocked=true; break; }
                    Thread.sleep(1);
                }
                assertTrue("worker never reached native transaction admission behind the held writer",blocked);
                clock.advance(31_000); released.set(true); release.countDown();
                var result=pending.get(5,java.util.concurrent.TimeUnit.SECONDS);
                assertEquals(result.toString(),"deadline",result.status()); assertFalse(result.sourceComplete());
                assertEquals("expired writer must not perform fixed reads after admission",0,postAdmissionReads.get());
            } finally {
                release.countDown(); holder.get(5,java.util.concurrent.TimeUnit.SECONDS); executor.shutdownNow(); executor.awaitTermination(5,java.util.concurrent.TimeUnit.SECONDS);
            }
            assertEquals(before,all(fixture.data())); assertEquals(beforeVersion,version(fixture.data())); assertFalse(sealed(fixture,first));
        }
    }
    @Test public void sourceInsertedBehindThePhysicalCursorRequiresANewAttemptThatIncludesIt() {
        Node inserted=id(999),newHead=id(25000);
        try(Fixture fixture=fixture(129,0,inserted)) {
            String attempt=UUID.randomUUID().toString(); var first=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,0,"")); assertEquals("committed",first.status());
            fixture.data().begin(ReadWrite.READ);
            try {
                byte[] earlier=new byte[8]; NodeIdFactory.set(TDBInternal.getNodeId(TDBInternal.requireStorage(fixture.data()),inserted),earlier,0);
                assertTrue("new C must occupy an actual NodeId before the checkpoint",Arrays.compareUnsigned(earlier,Arrays.copyOfRange(HexFormat.of().parseHex(first.next()),24,32))<0);
            } finally { fixture.data().end(); }
            fixture.data().begin(ReadWrite.WRITE); try { source(fixture.data(),inserted,newHead); fixture.data().commit(); } finally { fixture.data().end(); }
            Set<Quad> before=all(fixture.data());
            assertEquals("restart-required",ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),attempt,1,first.hash())).status()); assertEquals(before,all(fixture.data()));
            String restart=UUID.randomUUID().toString(),previous=""; Set<String> seen=new HashSet<>(); ClaimFoldInventory.Result last=null;
            for(int page=0;page<3;page++) {
                last=ClaimFoldInventory.turn(fixture.data(),request(fixture.job(),restart,page,previous)); assertEquals(last.toString(),"committed",last.status());
                for(var row:last.rows()) assertTrue(seen.add(row.claim()));
                if(last.sourceComplete()) break; previous=last.hash();
            }
            assertNotNull(last); assertTrue(last.sourceComplete()); assertEquals(130,last.total()); assertEquals(130,seen.size());
            assertTrue(seen.contains(inserted.getURI())); assertTrue(sealed(fixture,last)); assertNotEquals(first.sourceCut(),last.sourceCut());
        }
    }
    private static byte[] membersRequest(ClaimFoldInventory.Job job,ClaimFoldInventory.Result source,String progress) {
        return json(object("claimFoldMembers",object("job",object("dataEpoch",job.dataEpoch(),"routingEpoch",job.routingEpoch(),"marker",job.marker(),"mapDigest",job.mapDigest(),"job",job.job(),"acquireReceipt",job.acquireReceipt()),
            "sourceCut",source.sourceCut(),"seal",source.hash(),"progress",progress,"deadline",System.currentTimeMillis()+30_000))).getBytes(StandardCharsets.UTF_8);
    }
    private static org.apache.jena.atlas.json.JsonObject members(Fixture fixture,ClaimFoldInventory.Result source,String progress) {
        return ClaimFoldInventory.readMembers(fixture.data(),ClaimFoldInventory.parseMembers(membersRequest(fixture.job(),source,progress)));
    }
    private static String directoryStatus(org.apache.jena.atlas.json.JsonObject result) { return result.get("status").getAsString().value(); }
    /** Distinguish actual directory-prefix tuples (including lookahead) from bounded point records. */
    private static long[] directoryPhysical(Fixture fixture,Runnable consumed) {
        DatasetGraph data=fixture.data(); var storage=TDBInternal.requireStorage(data); var nodes=storage.getQuadTable().getNodeTupleTable().getNodeTable();
        var table=storage.getQuadTable().getNodeTupleTable().getTupleTable(); byte[] prefix=new byte[24]; long[] reads={0,0,0};
        data.begin(ReadWrite.READ);
        try { Node[] terms={STATE,uri(fixture.job().marker()+":inventory:members"),p("claimFoldInventoryMember")}; for(int i=0;i<3;i++) NodeIdFactory.set(TDBInternal.getNodeId(storage,terms[i]),prefix,i*8); }
        finally { data.end(); }
        var original=table.selectIndex("GSPO"); var base=(TupleIndexRecord)original.baseTupleIndex();
        var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},(proxy,method,args)->{
            Object result=method.invoke(base.getRangeIndex(),args);
            if(!method.getName().equals("iterator")) return result;
            boolean directory=args[0] instanceof org.apache.jena.dboe.base.record.Record start&&Arrays.equals(prefix,Arrays.copyOf(start.getKey(),24));
            return Iter.map((Iterator<?>)result,row->{
                reads[directory?0:1]++;
                if(directory) consumed.run();
                if(row instanceof org.apache.jena.dboe.base.record.Record record) for(int offset:List.of(16,24)) reads[2]+=NodeFmtLib.strNT(nodes.getNodeForNodeId(NodeIdFactory.get(record.getKey(),offset))).getBytes(StandardCharsets.UTF_8).length;
                return row;
            });
        });
        var counted=new TupleIndexRecord(4,original.getMapping(),"GSPO",range.getRecordFactory(),range);
        var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},(proxy,method,args)->{
            if(method.getName().equals("baseTupleIndex")) return counted;
            Object result=method.invoke(original,args);
            return method.getName().equals("find")&&result instanceof Iterator<?>?Iter.map((Iterator<?>)result,row->{
                reads[1]++;
                if(row instanceof org.apache.jena.atlas.lib.tuple.Tuple<?> tuple) for(int index:List.of(2,3)) reads[2]+=NodeFmtLib.strNT(nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(index))).getBytes(StandardCharsets.UTF_8).length;
                return row;
            }):result;
        });
        for(int i=0;i<table.numIndexes();i++) if(table.getIndex(i)==original) table.setTupleIndex(i,observed);
        return reads;
    }
    @Test public void sealedMemberDirectoryEnumeratesEveryOriginalRowWithBoundedNativeWorkAndReadOnlyReplay() {
        for(int population:List.of(129,3501)) {
            List<List<Long>> baseline=null;
            for(int unrelated:List.of(0,5000)) try(Fixture fixture=fixture(population,unrelated)) {
                fixture.data().begin(ReadWrite.WRITE);
                try {
                    for(int i=0;i<unrelated;i++) {
                        String attempt=UUID.nameUUIDFromBytes(("prior-attempt-"+i).getBytes(StandardCharsets.UTF_8)).toString();
                        Node acknowledgment=uri("urn:rezics:claim-inventory-turn:"+UUID.nameUUIDFromBytes(("prior-request-"+i).getBytes(StandardCharsets.UTF_8)));
                        var result=new ClaimFoldInventory.Result("committed",false,attempt,0,"",hash("prior-page-"+i),0,List.of(),hash("prior-cut-"+i),null);
                        add(fixture.data(),STATE,acknowledgment,p("inventoryJob"),uri(fixture.job().marker()+":inventory"),p("requestDigest"),text(hash("prior-request-"+i)),p("inventoryResult"),text(org.apache.jena.atlas.json.JSON.toStringFlat(ClaimFoldInventory.json(result))));
                        Node other=uri("urn:unrelated:inventory:"+i); add(fixture.data(),STATE,other,p("claimFoldInventoryMember"),uri(other.getURI()+":row"));
                    }
                    fixture.data().commit();
                } finally { fixture.data().end(); }
                // Multiple real attempts leave native page journals behind; enumeration must never scan them.
                ClaimFoldInventory.Result source=null;
                for(int attempt=0;attempt<3;attempt++) source=scan(fixture,physical(fixture.data()),new HashSet<>());
                Set<Quad> original=all(fixture.data()); long version=version(fixture.data()); long[] reads=directoryPhysical(fixture,()->{});
                Set<String> seen=new HashSet<>(); List<List<Long>> costs=new ArrayList<>(); String progress=""; int pages=0;
                do {
                    String submitted=progress; Arrays.fill(reads,0); var page=members(fixture,source,submitted);
                    List<Long> cost=List.of(reads[0],reads[1],reads[2]); costs.add(cost);
                    assertEquals(page.toString(),"read",directoryStatus(page)); assertTrue("directory tuple bound includes lookahead: "+cost,reads[0]<=128);
                    assertTrue("directory fixed metadata plus four original row fields: "+cost,reads[1]<=26+4L*page.get("rows").getAsArray().size()); assertTrue("directory consumed-byte bound: "+cost,reads[2]<=128L*1024);
                    assertTrue(page.get("rows").getAsArray().size()<=127);
                    for(var row:page.get("rows").getAsArray()) {
                        var value=row.getAsObject(); String claim=value.get("claim").getAsString().value(); assertTrue("directory member repeated",seen.add(claim));
                        int index=Integer.parseInt(claim.substring(claim.length()-12))-1000;
                        assertEquals(head(index).getURI(),value.get("head").getAsString().value()); assertTrue(value.get("witness").getAsString().value().matches("[0-9a-f]{64}"));
                    }
                    assertEquals(seen.size(),page.get("count").getAsNumber().value().intValue());
                    assertEquals("lost directory acknowledgment must replay exact bytes",page.toString(),members(fixture,source,submitted).toString());
                    assertEquals(original,all(fixture.data())); assertEquals(version,version(fixture.data()));
                    progress=page.get("progress").getAsString().value(); boolean eof=page.get("directoryEOF").getAsBoolean().value(); assertEquals(eof,progress.isEmpty());
                    assertEquals(source.sourceCut(),page.get("sourceCut").getAsString().value()); assertEquals(source.hash(),page.get("seal").getAsString().value());
                    assertTrue(++pages<=30);
                } while(!progress.isEmpty());
                assertEquals(population,seen.size());
                if(baseline==null) baseline=costs; else assertEquals("unrelated population/journals changed directory physical work",baseline,costs);
                System.out.println("claim directory source="+population+" unrelated="+unrelated+" prefix/points/decodedBytes="+costs);
            }
        }
    }
    private static ClaimFoldInventory.Result directorySource(Fixture fixture) { return scan(fixture,physical(fixture.data()),new HashSet<>()); }
    private static org.apache.jena.atlas.json.JsonObject alteredMembers(Fixture fixture,ClaimFoldInventory.Result source,String key,String value) {
        var request=org.apache.jena.atlas.json.JSON.parse(new String(membersRequest(fixture.job(),source,""),StandardCharsets.UTF_8));
        request.get("claimFoldMembers").getAsObject().put(key,value);
        return ClaimFoldInventory.readMembers(fixture.data(),ClaimFoldInventory.parseMembers(org.apache.jena.atlas.json.JSON.toStringFlat(request).getBytes(StandardCharsets.UTF_8)));
    }
    @Test public void directoryProofCursorRowsAndStorageIdentityCannotBeForgedOrRenewedByForeignWrites() {
        try(Fixture fixture=fixture(0,0)) {
            var source=directorySource(fixture); Set<Quad> before=all(fixture.data()); long version=version(fixture.data());
            var empty=members(fixture,source,""); assertEquals("read",directoryStatus(empty)); assertTrue(empty.get("directoryEOF").getAsBoolean().value()); assertEquals(0,empty.get("count").getAsNumber().value().intValue()); assertEquals(0,empty.get("rows").getAsArray().size()); assertEquals("",empty.get("progress").getAsString().value());
            assertEquals(before,all(fixture.data())); assertEquals(version,version(fixture.data()));
        }
        try(Fixture fixture=fixture(129,0)) {
            var source=directorySource(fixture); var first=members(fixture,source,""); String progress=first.get("progress").getAsString().value();
            Set<Quad> before=all(fixture.data()); long version=version(fixture.data());
            for(String key:List.of("sourceCut","seal","progress")) {
                String forged=key.equals("progress")?progress.substring(0,progress.length()-1)+(progress.endsWith("a")?"b":"a"):"0".repeat(64);
                assertEquals("invalid",directoryStatus(alteredMembers(fixture,source,key,forged))); assertEquals(before,all(fixture.data())); assertEquals(version,version(fixture.data()));
            }
            DatasetGraph copied=TDB2Factory.createDataset().asDatasetGraph();
            try(Fixture restored=new Fixture(copied,fixture.job())) {
                copied.begin(ReadWrite.WRITE); try { before.forEach(copied::add); copied.commit(); } finally { copied.end(); }
                Set<Quad> retained=all(copied); long restoredVersion=version(copied);
                assertEquals("invalid",directoryStatus(members(restored,source,progress))); assertEquals("invalid",directoryStatus(members(restored,source,"")));
                assertEquals(retained,all(copied)); assertEquals(restoredVersion,version(copied));
            }
            fixture.data().begin(ReadWrite.WRITE); try { fixture.data().add(CONTROL,uri("urn:directory:foreign"),p("heartbeat"),text("neutral physical commit")); fixture.data().commit(); } finally { fixture.data().end(); }
            before=all(fixture.data()); version=version(fixture.data());
            assertEquals("invalid",directoryStatus(members(fixture,source,progress))); assertEquals("invalid",directoryStatus(members(fixture,source,""))); assertEquals(before,all(fixture.data())); assertEquals(version,version(fixture.data()));
        }
        for(String defect:List.of("missing-seal","seal-count","missing-construction","missing-row","malformed-row","non-row-member","alias-duplicate")) try(Fixture fixture=fixture(129,0)) {
            var source=directorySource(fixture); DatasetGraph data=fixture.data(); Node header=uri(fixture.job().marker()+":inventory"),root=uri(header.getURI()+":members"),seal=uri(root.getURI()+":seal:"+source.attempt());
            data.begin(ReadWrite.WRITE);
            try {
                if(defect.equals("missing-seal")) data.deleteAny(STATE,seal,p("claimFoldDirectorySeal"),Node.ANY);
                else if(defect.equals("seal-count")) {
                    Node old=data.find(STATE,seal,p("claimFoldDirectorySeal"),Node.ANY).next().getObject(); var changed=org.apache.jena.atlas.json.JSON.parse(old.getLiteralLexicalForm()); changed.put("count",128);
                    data.deleteAny(STATE,seal,p("claimFoldDirectorySeal"),Node.ANY); data.add(STATE,seal,p("claimFoldDirectorySeal"),text(org.apache.jena.atlas.json.JSON.toStringFlat(changed)));
                } else if(defect.equals("missing-construction")) data.deleteAny(STATE,uri(root.getURI()+":construction"),p("claimFoldMemberConstruction"),Node.ANY);
                else if(defect.equals("non-row-member")) data.add(STATE,root,p("claimFoldInventoryMember"),text("not a native row reference"));
                else {
                    Node row=data.find(STATE,root,p("claimFoldInventoryMember"),Node.ANY).next().getObject();
                    if(defect.equals("missing-row")) data.deleteAny(STATE,row,Node.ANY,Node.ANY);
                    else if(defect.equals("alias-duplicate")) {
                        Node alias=uri(row.getURI()+":alias");
                        for(Quad field:Iter.toList(data.find(STATE,row,Node.ANY,Node.ANY))) data.add(STATE,alias,field.getPredicate(),field.getObject());
                        data.add(STATE,root,p("claimFoldInventoryMember"),alias);
                    } else data.add(STATE,row,p("extra"),text("unreviewed row field"));
                }
                // Simulate stopped private-state tampering, aligning only the claimed physical version so point guards are actually exercised.
                Node checkpoint=data.find(STATE,header,p("inventoryCheckpoint"),Node.ANY).next().getObject(); var changed=org.apache.jena.atlas.json.JSON.parse(checkpoint.getLiteralLexicalForm()); changed.put("version",TDBInternal.requireStorage(data).getTxnSystem().getThreadTransaction().getDataVersion()+1);
                data.deleteAny(STATE,header,p("inventoryCheckpoint"),Node.ANY); data.add(STATE,header,p("inventoryCheckpoint"),text(org.apache.jena.atlas.json.JSON.toStringFlat(changed))); data.commit();
            } finally { data.end(); }
            Set<Quad> before=all(data); long version=version(data); String progress=""; org.apache.jena.atlas.json.JsonObject refused=null; long[] reads=directoryPhysical(fixture,()->{});
            for(int page=0;page<3;page++) {
                Arrays.fill(reads,0); refused=members(fixture,source,progress);
                assertTrue("malformed member turn exceeded prefix work: "+defect,reads[0]<=128); assertTrue("malformed member turn exceeded fixed point work: "+defect,reads[1]<=26+4L*127); assertTrue("malformed member turn exceeded fixed byte work: "+defect,reads[2]<=128L*1024);
                assertEquals(before,all(data)); assertEquals(version,version(data));
                if(!directoryStatus(refused).equals("read")) break;
                assertFalse("malformed directory must never attest EOF: "+defect,refused.get("directoryEOF").getAsBoolean().value());
                progress=refused.get("progress").getAsString().value();
            }
            assertNotNull(refused); assertEquals(defect+": "+refused,"invalid",directoryStatus(refused));
            if(defect.equals("alias-duplicate")) assertTrue("a copied member cannot borrow another row identity: "+refused,refused.get("error").getAsString().value().contains("identity"));
            if(defect.equals("missing-seal")||defect.equals("missing-construction")) {
                var fresh=ClaimFoldInventory.turn(data,request(fixture.job(),UUID.randomUUID().toString(),0,""));
                assertEquals("missing original proof cannot be retrofitted by a new capture: "+defect+": "+fresh,"invalid",fresh.status()); assertFalse(fresh.sourceComplete());
                assertEquals(before,all(data)); assertEquals(version,version(data));
            }
        }
    }
    @Test public void interruptedDirectoryReadHasNoPartialAuthorityOrWritesAndTheSameContinuationRemainsUsable() {
        try(Fixture fixture=fixture(129,0)) {
            var source=directorySource(fixture); var first=members(fixture,source,""); String progress=first.get("progress").getAsString().value();
            Set<Quad> before=all(fixture.data()); long version=version(fixture.data()); var armed=new java.util.concurrent.atomic.AtomicBoolean(true);
            long[] reads=directoryPhysical(fixture,()->{ if(armed.compareAndSet(true,false)) Thread.currentThread().interrupt(); });
            org.apache.jena.atlas.json.JsonObject refused;
            try { refused=members(fixture,source,progress); } finally { Thread.interrupted(); }
            assertTrue("cancellation must occur after a native directory tuple is consumed",reads[0]>0); assertEquals(refused.toString(),"deadline",directoryStatus(refused));
            assertFalse("cancelled read must not attest directory EOF",refused.hasKey("directoryEOF")&&refused.get("directoryEOF").getAsBoolean().value());
            assertEquals(before,all(fixture.data())); assertEquals(version,version(fixture.data()));
            var resumed=members(fixture,source,progress); assertEquals(resumed.toString(),"read",directoryStatus(resumed)); assertTrue(resumed.get("directoryEOF").getAsBoolean().value()); assertEquals(129,resumed.get("count").getAsNumber().value().intValue());
            assertEquals(before,all(fixture.data())); assertEquals(version,version(fixture.data()));
        }
    }
    @Test public void interruptionAfterANativeMemberPointerIsStagedAbortsCaptureAndExactRetryBuildsTheDirectory() {
        try(Fixture fixture=fixture(1,0)) {
            DatasetGraph data=fixture.data(); var storage=TDBInternal.requireStorage(data); var nodes=storage.getQuadTable().getNodeTupleTable().getNodeTable();
            var table=storage.getQuadTable().getNodeTupleTable().getTupleTable(); var original=table.selectIndex("GSPO");
            Node root=uri(fixture.job().marker()+":inventory:members"); var armed=new java.util.concurrent.atomic.AtomicBoolean(true); var staged=new java.util.concurrent.atomic.AtomicBoolean();
            var observed=(org.apache.jena.tdb2.store.tupletable.TupleIndex)java.lang.reflect.Proxy.newProxyInstance(org.apache.jena.tdb2.store.tupletable.TupleIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.tdb2.store.tupletable.TupleIndex.class},(proxy,method,args)->{
                Object result=method.invoke(original,args);
                if(method.getName().equals("add")&&args[0] instanceof org.apache.jena.atlas.lib.tuple.Tuple<?> tuple) {
                    Node graph=nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(0)),subject=nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(1)),predicate=nodes.getNodeForNodeId((org.apache.jena.tdb2.store.NodeId)tuple.get(2));
                    if(graph.equals(STATE)&&subject.equals(root)&&predicate.equals(p("claimFoldInventoryMember"))&&armed.compareAndSet(true,false)) {
                        staged.set(true); Thread.currentThread().interrupt();
                    }
                }
                return result;
            });
            for(int i=0;i<table.numIndexes();i++) if(table.getIndex(i)==original) table.setTupleIndex(i,observed);
            var request=request(fixture.job(),UUID.randomUUID().toString(),0,""); Set<Quad> before=all(data); long version=version(data); ClaimFoldInventory.Result refused;
            try { refused=ClaimFoldInventory.turn(data,request); } finally { Thread.interrupted(); }
            assertTrue("native add must complete before cancellation",staged.get()); assertEquals(refused.toString(),"deadline",refused.status()); assertFalse(refused.sourceComplete());
            assertEquals("pointer, original row, checkpoint, ack, construction and seal must abort together",before,all(data)); assertEquals(version,version(data));
            var retry=ClaimFoldInventory.turn(data,request); assertEquals(retry.toString(),"committed",retry.status()); assertTrue(retry.sourceComplete()); assertEquals(1,retry.rows().size());
            Set<Quad> committed=all(data); long committedVersion=version(data); var directory=members(fixture,retry,"");
            assertEquals(directory.toString(),"read",directoryStatus(directory)); assertTrue(directory.get("directoryEOF").getAsBoolean().value()); assertEquals(1,directory.get("rows").getAsArray().size());
            assertEquals(retry,ClaimFoldInventory.turn(data,request)); assertEquals(committed,all(data)); assertEquals(committedVersion,version(data));
        }
    }
}
