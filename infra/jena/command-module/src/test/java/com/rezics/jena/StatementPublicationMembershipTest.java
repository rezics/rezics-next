package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class StatementPublicationMembershipTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS), CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node SUBJECT = nativeId(3,0), DISTANT = nativeId(4,0);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return uri(RV + value); }
    private static Node nativeId(int kind, int n) { return uri("https://rezics.com/id/%08x-0000-4000-8000-%012x".formatted(kind,n)); }
    private static Node statement(int n) { return nativeId(1,n); }
    private static Node head(int n) { return nativeId(2,n); }
    private static CommandPolicy.Plan plan(Node... ids) {
        return new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT,CommandPolicy.REVISIONS),
            java.util.Arrays.stream(ids).map(Node::getURI).collect(java.util.stream.Collectors.toSet()), Set.of(),Set.of(),false,false,false);
    }
    private static void record(DatasetGraph data, Node id, Node subject, Node revision, boolean source, boolean evidence) {
        data.deleteAny(CURRENT,id,Node.ANY,Node.ANY);
        data.add(CURRENT,id,RDF.type.asNode(),RDF.Statement.asNode());
        data.add(CURRENT,id,RDF.subject.asNode(),subject);
        data.add(CURRENT,id,RDF.predicate.asNode(),rv("classifiedAs"));
        data.add(CURRENT,id,rv("meaningKey"),uri("urn:rezics:meaning:" + "a".repeat(64)));
        data.add(CURRENT,id,rv("head"),revision);
        data.add(CURRENT,id,rv("statementState"),rv("Active"));
        if(source) data.add(CURRENT,id,rv("source"),nativeId(5,0));
        if(evidence) data.add(REVISIONS,revision,rv("evidence"),uri("urn:test:citation"));
    }
    private static Node membership(DatasetGraph data, Node subject) {
        var rows=data.find(CONTROL,subject,rv("statementPublicationMembershipHead"),Node.ANY);
        try { if(!rows.hasNext()) return null; Node result=rows.next().getObject(); assertFalse(rows.hasNext());return result; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    @Test public void sourceEvidenceHeadWithdrawalAndDistantLocalityStayAtomic() {
        DatasetGraph data=DatasetFactory.createTxnMem().asDatasetGraph();
        try {
            data.begin(ReadWrite.WRITE);
            var ordinary=new StatementPublicationMembership(data,plan(statement(1)));
            record(data,statement(1),SUBJECT,head(1),false,false);ordinary.advance("urn:test:receipt:ordinary");
            assertNull(membership(data,SUBJECT));
            var evidence=new StatementPublicationMembership(data,plan(statement(1)));
            record(data,statement(1),SUBJECT,head(2),false,true);evidence.advance("urn:test:receipt:evidence");
            assertEquals(uri("urn:test:receipt:evidence"),membership(data,SUBJECT));
            var replay=new StatementPublicationMembership(data,plan(statement(1)));replay.advance("urn:test:receipt:replay");
            assertEquals(uri("urn:test:receipt:evidence"),membership(data,SUBJECT));
            var distant=new StatementPublicationMembership(data,plan(statement(2)));
            record(data,statement(2),DISTANT,head(3),true,false);distant.advance("urn:test:receipt:distant");
            assertEquals(uri("urn:test:receipt:evidence"),membership(data,SUBJECT));
            assertEquals(uri("urn:test:receipt:distant"),membership(data,DISTANT));
            var newer=new StatementPublicationMembership(data,plan(statement(1)));
            record(data,statement(1),SUBJECT,head(4),true,false);newer.advance("urn:test:receipt:new-head");
            assertEquals(uri("urn:test:receipt:new-head"),membership(data,SUBJECT));
            data.commit();data.end();
            data.begin(ReadWrite.WRITE);
            var aborted=new StatementPublicationMembership(data,plan(statement(1)));
            data.deleteAny(CURRENT,statement(1),rv("statementState"),Node.ANY);
            data.add(CURRENT,statement(1),rv("statementState"),rv("Withdrawn"));aborted.advance("urn:test:receipt:aborted");
            assertEquals(uri("urn:test:receipt:aborted"),membership(data,SUBJECT));data.abort();data.end();
            data.begin(ReadWrite.WRITE);
            assertEquals(uri("urn:test:receipt:new-head"),membership(data,SUBJECT));
            var withdrawn=new StatementPublicationMembership(data,plan(statement(1)));
            data.deleteAny(CURRENT,statement(1),rv("statementState"),Node.ANY);
            data.add(CURRENT,statement(1),rv("statementState"),rv("Withdrawn"));withdrawn.advance("urn:test:receipt:withdrawn");
            assertEquals(uri("urn:test:receipt:withdrawn"),membership(data,SUBJECT));data.commit();data.end();
        } finally {data.close();}
    }
    @Test public void compoundChangesReplaceOneSubjectHeadAndPreserveOtherSubjects() {
        DatasetGraph data=DatasetFactory.createTxnMem().asDatasetGraph();
        try {data.begin(ReadWrite.WRITE);
            var batch=new StatementPublicationMembership(data,plan(statement(1),statement(2),statement(3)));
            record(data,statement(1),SUBJECT,head(1),true,false);
            record(data,statement(2),SUBJECT,head(2),false,true);
            record(data,statement(3),DISTANT,head(3),false,false);batch.advance("urn:test:receipt:batch");
            assertEquals(uri("urn:test:receipt:batch"),membership(data,SUBJECT));assertNull(membership(data,DISTANT));
            var move=new StatementPublicationMembership(data,plan(statement(1)));
            record(data,statement(1),DISTANT,head(4),true,false);move.advance("urn:test:receipt:move");
            assertEquals(uri("urn:test:receipt:move"),membership(data,SUBJECT));
            assertEquals(uri("urn:test:receipt:move"),membership(data,DISTANT));data.commit();data.end();
        }finally{data.close();}
    }
    @Test public void ambiguousSourceRefusesRatherThanPublishingAFalseBasis() {
        DatasetGraph data=DatasetFactory.createTxnMem().asDatasetGraph();
        try{data.begin(ReadWrite.WRITE);record(data,statement(1),SUBJECT,head(1),true,false);
            data.add(CURRENT,statement(1),rv("head"),head(2));
            try{new StatementPublicationMembership(data,plan(statement(1)));fail("ambiguous head accepted");}
            catch(IllegalArgumentException expected){assertTrue(expected.getMessage().contains("ambiguous"));}
            data.abort();data.end();
        }finally{data.close();}
    }
    private static ProfileRegistry commandProfiles() throws Exception {
        Files.createDirectories(Path.of("tmp"));
        Path directory=Files.createTempDirectory(Path.of("tmp"),"publication-profiles-");
        String shape="@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rv: <"+RV+"> . <urn:test:statement-shape> a sh:NodeShape ; sh:property [ sh:path rv:speaker ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] . <urn:test:revision-shape> a sh:NodeShape .";
        Files.writeString(directory.resolve("shape.ttl"),shape);
        String digest=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(shape.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Files.writeString(directory.resolve("manifest.json"),"{\"bindingDemands\":[],\"profiles\":[{\"id\":\"statement-v1\",\"sha256\":\""+digest+"\",\"file\":\"shape.ttl\"}],\"canonical\":[{\"type\":\""+RDF.Statement.getURI()+"\",\"routes\":[{\"profile\":\"statement-v1\",\"shape\":\"urn:test:statement-shape\",\"when\":[]}]},{\"type\":\""+RV+"StatementRevision\",\"routes\":[{\"profile\":\"statement-v1\",\"shape\":\"urn:test:revision-shape\",\"when\":[]}]}]}");
        return ProfileRegistry.load(directory);
    }
    private static String command(String receipt,Node id,int sequence,boolean withdraw,boolean invalid) {
        String own="<"+receipt+">", current="<"+CommandPolicy.CURRENT+">", revisions="<"+CommandPolicy.REVISIONS+">";
        String revision="<urn:test:command-head:"+receipt.substring(receipt.lastIndexOf(':')+1)+">", statement="<"+id.getURI()+">";
        String delete=withdraw?" GRAPH "+current+" { "+statement+" rv:head <urn:test:command-head:record> ; rv:statementState rv:Active . }":"";
        String speaker=invalid?"":" rv:speaker <urn:test:speaker> ;";
        String state=withdraw?"Withdrawn":"Active";
        return "PREFIX rv: <"+RV+"> PREFIX rdf: <"+RDF.uri+"> DELETE { GRAPH <"+CommandPolicy.CONTROL+"> { <urn:rezics:dataset:product> rv:sequence ?n }"+delete+" } INSERT {"
            +" GRAPH <"+CommandPolicy.CONTROL+"> { <urn:rezics:dataset:product> rv:sequence ?next } GRAPH "+current+" { "+statement+" a rdf:Statement ; rdf:subject <"+SUBJECT.getURI()+"> ; rdf:predicate rv:classifiedAs ; rv:meaningKey <urn:rezics:meaning:"+"a".repeat(64)+"> ;"+speaker+" rv:head "+revision+" ; rv:statementState rv:"+state+" ; rv:source <urn:test:content> . }"
            +" GRAPH "+revisions+" { "+revision+" a rv:StatementRevision,rv:RevisionAnchor ; rv:component "+statement+" ; rv:modelRevision <https://rezics.com/definition/statement-v1> ; rv:statementState rv:"+state+" . "+(withdraw?revision+" rv:predecessor <urn:test:command-head:record> .":"")+" }"
            +" GRAPH <"+CommandPolicy.RECEIPTS+"> { "+own+" a rv:OperationReceipt ; rv:requestDigest \""+"a".repeat(64)+"\" ; rv:outcome rv:Succeeded ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch \"epoch\" ; rv:sequence ?next ; rv:admissionId \"00000000-0000-4000-8000-000000000001\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"statement:speak:urn:test:speaker\" ; rv:component "+statement+" ; rv:revision "+revision+" ; rv:commandFamily \""+(withdraw?"statement-withdraw-v1":"statement-record-v1")+"\" . "+(withdraw?own+" rv:expectedHead <urn:test:command-head:record> .":"")+" }"
            +" GRAPH <"+CommandPolicy.OUTBOX+"> { <"+receipt+":batch> a rv:OutboxBatch ; rv:dataEpoch \"epoch\" ; rv:sequence ?next ; rv:eventCount 1 ; rv:event <"+receipt+":event> . <"+receipt+":event> a rv:StatementRecordedEvent ; rv:ordinal 0 ; rv:receipt "+own+" . } } WHERE { GRAPH <"+CommandPolicy.CONTROL+"> { <urn:rezics:dataset:product> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"0\" ; rv:sequence ?n . FILTER(?n="+sequence+") } BIND(?n+1 AS ?next) }";
    }
    private static List<CommandService.Validation> commandValidations(ProfileRegistry profiles,Node id,String receipt) {
        return List.of(new CommandService.Validation("statement-v1",profiles.get("statement-v1"),"urn:test:statement-shape",List.of(id.getURI()),List.of(CommandPolicy.CURRENT),java.util.Map.of()),
            new CommandService.Validation("statement-v1",profiles.get("statement-v1"),"urn:test:revision-shape",List.of("urn:test:command-head:"+receipt.substring(receipt.lastIndexOf(':')+1)),List.of(CommandPolicy.REVISIONS),java.util.Map.of()));
    }
    @Test public void actualCommandHooksCommitReplayAbortWithdrawAndBulk() throws Exception {
        ProfileRegistry profiles=commandProfiles();var service=new CommandService(profiles,"1".repeat(64).getBytes(),"2".repeat(64).getBytes(),"3".repeat(64).getBytes());
        DatasetGraph data=DatasetFactory.createTxnMem().asDatasetGraph();
        try {
            data.begin(ReadWrite.WRITE);org.apache.jena.update.UpdateAction.parseExecute("PREFIX rv: <"+RV+"> INSERT DATA { GRAPH <"+CommandPolicy.CONTROL+"> { <urn:rezics:dataset:product> rv:dataEpoch \"epoch\" ; rv:routingEpoch \"0\" ; rv:sequence 0 } }",DatasetFactory.wrap(data));data.commit();data.end();
            String record="urn:test:receipt:record",bad="urn:test:receipt:bad",withdraw="urn:test:receipt:withdraw";
            var first=service.runCommand(data,record,"a".repeat(64),command(record,statement(1),0,false,false),commandValidations(profiles,statement(1),record),System.nanoTime()+10_000_000_000L);
            assertEquals(first.toString(),"committed",first.get("status"));
            var replay=service.runCommand(data,record,"a".repeat(64),command(record,statement(1),0,false,false),commandValidations(profiles,statement(1),record),System.nanoTime()+10_000_000_000L);
            assertEquals("committed",replay.get("status"));assertEquals(first.get("position"),replay.get("position"));
            data.begin(ReadWrite.READ);assertEquals(uri(record),membership(data,SUBJECT));data.end();
            var invalid=service.runCommand(data,bad,"a".repeat(64),command(bad,statement(2),1,false,true),commandValidations(profiles,statement(2),bad),System.nanoTime()+10_000_000_000L);
            assertEquals(invalid.toString(),"invalid",invalid.get("status"));data.begin(ReadWrite.READ);assertEquals(uri(record),membership(data,SUBJECT));assertFalse(data.contains(CURRENT,statement(2),Node.ANY,Node.ANY));data.end();
            var retired=service.runCommand(data,withdraw,"a".repeat(64),command(withdraw,statement(1),1,true,false),commandValidations(profiles,statement(1),withdraw),System.nanoTime()+10_000_000_000L);
            assertEquals(retired.toString(),"committed",retired.get("status"));data.begin(ReadWrite.READ);assertEquals(uri(withdraw),membership(data,SUBJECT));data.end();
            String receipt="urn:test:receipt:bulk",update=command(receipt,statement(3),2,false,false);
            var item=new CommandService.BulkItem(receipt,"a".repeat(64),update,CommandPolicy.parse(update,receipt),commandValidations(profiles,statement(3),receipt),null,null);
            var bulk=service.runBulk(data,List.of(item),System.nanoTime()+10_000_000_000L);
            assertTrue(bulk.toString(),bulk.toString().contains("status=committed"));data.begin(ReadWrite.READ);assertEquals(uri(receipt),membership(data,SUBJECT));data.end();
        } finally {data.close();}
    }
    private static org.apache.jena.atlas.json.JsonObject pageRequest(Object after, String expectedHead) {
        var request = new java.util.LinkedHashMap<String,Object>();
        request.put("operation","statement-publication-page"); request.put("dataEpoch","epoch"); request.put("routingEpoch","0");
        request.put("subject",SUBJECT.getURI()); request.put("membershipHead",expectedHead == null ? org.apache.jena.atlas.json.JsonNull.instance : expectedHead); request.put("after",after == null ? org.apache.jena.atlas.json.JsonNull.instance : after);
        return CommandService.jsonObject(request);
    }
    private static void seedControl(DatasetGraph data) {
        data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("dataEpoch"),NodeFactory.createLiteralString("epoch"));
        data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("routingEpoch"),NodeFactory.createLiteralString("0"));
        data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("sequence"),NodeFactory.createLiteralByValue(0,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
    }
    private static Path pageDirectory() throws Exception { Files.createDirectories(Path.of("tmp")); return Files.createTempDirectory(Path.of("tmp"),"publication-page-"); }
    @SuppressWarnings("unchecked") private static List<java.util.Map<String,Object>> references(java.util.Map<String,Object> result) { return (List<java.util.Map<String,Object>>)result.get("references"); }
    private static void refused(Runnable run, String reason) {
        try { run.run(); fail("unsafe publication page was accepted"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage(),expected.getMessage().contains(reason)); }
    }
    @Test public void actual127128129BothPhysicalPrefixesCountLookaheadAndTrueEof() throws Exception {
        for (int count : new int[]{127,128,129}) {
            var dataset = TDB2Factory.connectDataset(pageDirectory().toString()); var data=dataset.asDatasetGraph();
            try {
                data.begin(ReadWrite.WRITE); seedControl(data);
                for (int i=0;i<count;i++) {
                    record(data,statement(i),SUBJECT,head(i),true,false);
                    if (i>=64) {
                        var rows=data.find(CURRENT,statement(i),Node.ANY,Node.ANY);var moved=new ArrayList<Quad>();
                        try { rows.forEachRemaining(moved::add); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                        data.deleteAny(CURRENT,statement(i),Node.ANY,Node.ANY);
                        for (var row:moved) data.add(Quad.defaultGraphNodeGenerated,row.getSubject(),row.getPredicate(),row.getObject());
                    }
                }
                data.commit(); data.end();
                var capture=StatementPublicationMembership.read(data,pageRequest("basis",null));
                assertSame(org.apache.jena.atlas.json.JsonNull.instance,capture.get("after"));assertEquals(false,capture.get("complete"));assertEquals(0,capture.get("examined"));
                var first=StatementPublicationMembership.read(data,pageRequest(null,null));
                assertEquals(Math.min(count,128),first.get("examined"));assertEquals(127,references(first).size());
                assertEquals(count==127,first.get("complete"));assertTrue((int)first.get("witnessTuples")<=StatementPublicationMembership.MAX_WITNESS_TUPLES);
                var next=StatementPublicationMembership.read(data,pageRequest(first.get("after"),null));
                assertEquals(count-127,next.get("examined"));assertEquals(count-127,references(next).size());assertEquals(true,next.get("complete"));
                var eof=StatementPublicationMembership.read(data,pageRequest(next.get("after"),null));
                assertEquals(true,eof.get("complete"));assertEquals(0,eof.get("examined"));assertTrue(references(eof).isEmpty());
                assertFalse(data.isInTransaction());
            } finally {dataset.close();}
        }
    }
    @Test public void ordinaryAndDistantPopulationsStayPhysicallyBoundedAndEmptyIsNotEof() throws Exception {
        for (int population : new int[]{0,320,4096}) {
            var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
            try {
                data.begin(ReadWrite.WRITE);seedControl(data);
                for(int i=0;i<population+2;i++)record(data,statement(i),SUBJECT,head(i),i<2,false);
                for(int i=0;i<4096;i++)record(data,statement(10000+i),DISTANT,head(10000+i),true,false);
                data.commit();data.end();
                Object after=null;int pages=0,total=0,potentials=0;boolean emptyProgress=false;
                do {
                    var page=StatementPublicationMembership.read(data,pageRequest(after,null));
                    int examined=(int)page.get("examined");assertTrue(examined<=128);assertTrue((int)page.get("witnessTuples")<=StatementPublicationMembership.MAX_WITNESS_TUPLES);
                    assertTrue(CommandService.jsonObject(page).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=StatementPublicationMembership.MAX_PAGE_BYTES);
                    total+=examined;potentials+=references(page).size();pages++;
                    if(references(page).isEmpty() && !Boolean.TRUE.equals(page.get("complete")))emptyProgress=true;
                    after=page.get("after");if(Boolean.TRUE.equals(page.get("complete")))break;
                    assertTrue(pages<40);
                }while(true);
                assertEquals(2,potentials);assertEquals(population+2+pages-1,total);assertEquals((population+2+126)/127,pages);
                if(population==4096)assertTrue(emptyProgress);
                System.out.println("publication native population="+population+" distant=4096 pages="+pages+" physical_including_lookahead="+total+" potentials="+potentials);
            }finally{dataset.close();}
        }
    }
    @Test public void sourceCasReplayDeletedRawCursorAndUnrelatedWritesPreserveExactContinuation() throws Exception {
        var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
        try {
            data.begin(ReadWrite.WRITE);seedControl(data);
            for(int i=0;i<129;i++)record(data,statement(i),SUBJECT,head(i),false,false);
            data.commit();data.end();
            var first=StatementPublicationMembership.read(data,pageRequest(null,null));
            assertEquals(false,first.get("complete"));assertTrue(references(first).isEmpty());
            var replay=StatementPublicationMembership.read(data,pageRequest(null,null));assertEquals(first,replay);
            data.begin(ReadWrite.WRITE);data.deleteAny(CURRENT,statement(126),Node.ANY,Node.ANY);
            data.deleteAny(CONTROL,uri("urn:rezics:dataset:product"),rv("sequence"),Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("sequence"),NodeFactory.createLiteralByValue(7,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));data.commit();data.end();
            var next=StatementPublicationMembership.read(data,pageRequest(first.get("after"),null));assertEquals(true,next.get("complete"));assertEquals(2,next.get("examined"));
            data.begin(ReadWrite.WRITE);var edit=new StatementPublicationMembership(data,plan(statement(0)));
            record(data,statement(0),SUBJECT,head(130),false,true);edit.advance("urn:test:new-potential");data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest(first.get("after"),null)),"basis");
            refused(()->StatementPublicationMembership.read(data,pageRequest(next.get("after"),"urn:test:new-potential")),"seal");
            var restarted=StatementPublicationMembership.read(data,pageRequest(null,"urn:test:new-potential"));assertFalse(references(restarted).isEmpty());
            data.begin(ReadWrite.WRITE);var aborted=new StatementPublicationMembership(data,plan(statement(0)));data.deleteAny(CURRENT,statement(0),Node.ANY,Node.ANY);aborted.advance("urn:test:abort");data.abort();data.end();
            assertEquals(restarted,StatementPublicationMembership.read(data,pageRequest(null,"urn:test:new-potential")));
            data.begin(ReadWrite.WRITE);var withdrawn=new StatementPublicationMembership(data,plan(statement(0)));
            data.deleteAny(CURRENT,statement(0),rv("statementState"),Node.ANY);data.add(CURRENT,statement(0),rv("statementState"),rv("Withdrawn"));
            withdrawn.advance("urn:test:withdrawn-potential");data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest(restarted.get("after"),"urn:test:new-potential")),"basis");
            assertTrue(references(StatementPublicationMembership.read(data,pageRequest(null,"urn:test:withdrawn-potential"))).isEmpty());
        } finally {dataset.close();}
    }
    @Test public void aliasesEvidenceAndNoCurrentGlobalFactsAreExactNotNullPolicy() throws Exception {
        var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
        try {
            data.begin(ReadWrite.WRITE);seedControl(data);record(data,statement(1),SUBJECT,head(1),false,true);
            var rows=data.find(CURRENT,statement(1),Node.ANY,Node.ANY);var copy=new ArrayList<Quad>();
            try{rows.forEachRemaining(copy::add);}finally{org.apache.jena.atlas.iterator.Iter.close(rows);}
            for(var row:copy)data.add(Quad.defaultGraphNodeGenerated,row.getSubject(),row.getPredicate(),row.getObject());
            data.add(Quad.defaultGraphNodeGenerated,statement(1),rv("applicability"),uri("urn:test:realm"));data.commit();data.end();
            var page=StatementPublicationMembership.read(data,pageRequest(null,null));assertEquals(2,page.get("examined"));assertEquals(2,references(page).size());
            assertEquals(List.of("urn:test:realm"),references(page).getFirst().get("applicability"));assertEquals(true,references(page).getFirst().get("hasEvidence"));assertSame(org.apache.jena.atlas.json.JsonNull.instance,references(page).getFirst().get("source"));
            data.begin(ReadWrite.WRITE);data.add(Quad.defaultGraphNodeGenerated,statement(1),rv("head"),head(2));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest(null,null)),"witness");
            data.begin(ReadWrite.WRITE);data.delete(Quad.defaultGraphNodeGenerated,statement(1),rv("head"),head(2));
            data.add(Quad.defaultGraphNodeGenerated,uri("urn:rezics:classification-context:global"),rv("contextState"),rv("Withdrawn"));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest("basis",null)),"Global facts");
            data.begin(ReadWrite.WRITE);data.deleteAny(Quad.defaultGraphNodeGenerated,uri("urn:rezics:classification-context:global"),Node.ANY,Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("restoreHold"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest("basis",null)),"basis");assertFalse(data.isInTransaction());
        }finally{dataset.close();}
    }
    @Test public void physicalNodeIdOrderNeverBecomesLogicalCOrderAndTokensCannotBeSpliced() throws Exception {
        var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
        try{
            data.begin(ReadWrite.WRITE);seedControl(data);
            Node supplementary=uri("urn:test:predicate:"+new String(Character.toChars(0x10000))),bmp=uri("urn:test:predicate:"+(char)0xE000);
            record(data,statement(2),SUBJECT,head(1),true,false);record(data,statement(1),SUBJECT,head(2),true,false);
            data.deleteAny(CURRENT,statement(2),RDF.predicate.asNode(),Node.ANY);data.add(CURRENT,statement(2),RDF.predicate.asNode(),supplementary);
            data.deleteAny(CURRENT,statement(1),RDF.predicate.asNode(),Node.ANY);data.add(CURRENT,statement(1),RDF.predicate.asNode(),bmp);data.commit();data.end();
            var page=StatementPublicationMembership.read(data,pageRequest(null,null));
            assertEquals(statement(2).getURI(),references(page).getFirst().get("statementId"));
            assertEquals(supplementary.getURI(),references(page).getFirst().get("predicate"));
            assertTrue(supplementary.getURI().compareTo(bmp.getURI())<0);
            assertTrue(java.util.Arrays.compareUnsigned(supplementary.getURI().getBytes(java.nio.charset.StandardCharsets.UTF_8),bmp.getURI().getBytes(java.nio.charset.StandardCharsets.UTF_8))>0);
            var token=new java.util.LinkedHashMap<String,Object>();token.putAll((java.util.Map<String,Object>)page.get("after"));token.put("phase",0);
            refused(()->StatementPublicationMembership.read(data,pageRequest(token,null)),"seal");
            Thread.currentThread().interrupt();try{refused(()->StatementPublicationMembership.read(data,pageRequest(null,null)),"deadline");}finally{Thread.interrupted();}
            assertFalse(data.isInTransaction());
        }finally{dataset.close();}
        DatasetGraph memory=DatasetFactory.createTxnMem().asDatasetGraph();
        try{try{StatementPublicationMembership.read(memory,pageRequest(null,null));fail("unknown store accepted");}catch(RuntimeException expected){assertFalse(memory.isInTransaction());}}finally{memory.close();}
    }
    @Test public void reopenedOrDifferentStoreRejectsOldEofCertificate() throws Exception {
        Path directory=pageDirectory();var dataset=TDB2Factory.connectDataset(directory.toString());var data=dataset.asDatasetGraph();
        data.begin(ReadWrite.WRITE);seedControl(data);data.commit();data.end();
        var eof=StatementPublicationMembership.read(data,pageRequest(null,null));assertEquals(true,eof.get("complete"));
        org.apache.jena.tdb2.sys.TDBInternal.expel(data);dataset.close();
        var reopened=TDB2Factory.connectDataset(directory.toString());
        try{refused(()->StatementPublicationMembership.read(reopened.asDatasetGraph(),pageRequest(eof.get("after"),null)),"restart");
            assertEquals(true,StatementPublicationMembership.read(reopened.asDatasetGraph(),pageRequest(null,null)).get("complete"));
        }finally{reopened.close();}
    }
    @Test public void closedInputsMalformedNativeReferencesAndUtf8BytesRefuseWithoutLeakedTransactions() throws Exception {
        var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
        try {
            data.begin(ReadWrite.WRITE);seedControl(data);record(data,statement(1),SUBJECT,head(1),true,false);data.commit();data.end();
            var extra=pageRequest(null,null);extra.put("graph",CURRENT.getURI());
            refused(()->StatementPublicationMembership.read(data,extra),"closed");assertFalse(data.isInTransaction());
            var foreign=pageRequest(null,null);foreign.put("subject","urn:test:foreign");
            refused(()->StatementPublicationMembership.read(data,foreign),"native identity");assertFalse(data.isInTransaction());
            data.begin(ReadWrite.WRITE);data.deleteAny(CURRENT,statement(1),rv("source"),Node.ANY);data.add(CURRENT,statement(1),rv("source"),uri("urn:test:foreign"));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest(null,null)),"native identity");assertFalse(data.isInTransaction());
            data.begin(ReadWrite.WRITE);data.deleteAny(CURRENT,statement(1),rv("source"),Node.ANY);data.add(CURRENT,statement(1),rv("source"),nativeId(5,0));
            data.add(CURRENT,statement(1),rv("applicability"),uri("urn:test:"+"é".repeat(1100)));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest(null,null)),"byte bound");assertFalse(data.isInTransaction());
            data.begin(ReadWrite.WRITE);data.deleteAny(CURRENT,statement(1),rv("applicability"),Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("dataEpoch"),NodeFactory.createLiteralString("conflict"));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,pageRequest("basis",null)),"ambiguous");assertFalse(data.isInTransaction());
            String routing="c011e721-d768-44e2-ac04-9f5f3d10d7de",changedRouting="c011e721-d768-44e2-ac04-9f5f3d10d7df";
            data.begin(ReadWrite.WRITE);data.deleteAny(CONTROL,uri("urn:rezics:dataset:product"),rv("dataEpoch"),Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("dataEpoch"),NodeFactory.createLiteralString("epoch"));
            data.deleteAny(CONTROL,uri("urn:rezics:dataset:product"),rv("routingEpoch"),Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("routingEpoch"),NodeFactory.createLiteralString(routing));data.commit();data.end();
            var capture=pageRequest("basis",null);capture.put("routingEpoch",routing);
            var basis=StatementPublicationMembership.read(data,capture);assertEquals(0,basis.get("examined"));assertEquals(false,basis.get("complete"));
            assertEquals(routing,((java.util.Map<?,?>)basis.get("basis")).get("routingEpoch"));
            var valid=pageRequest(null,null);valid.put("routingEpoch",routing);
            var uuidPage=StatementPublicationMembership.read(data,valid);assertEquals(1,uuidPage.get("examined"));assertEquals(true,uuidPage.get("complete"));assertEquals(1,references(uuidPage).size());
            var eof=pageRequest(uuidPage.get("after"),null);eof.put("routingEpoch",routing);
            var checked=StatementPublicationMembership.read(data,eof);assertEquals(0,checked.get("examined"));assertEquals(true,checked.get("complete"));
            var changed=pageRequest(uuidPage.get("after"),null);changed.put("routingEpoch",changedRouting);
            refused(()->StatementPublicationMembership.read(data,changed),"basis");
            for(String invalid:new String[]{"","ab\0cd","\uD800","a".repeat(129),"é".repeat(65)}) {
                var request=pageRequest("basis",null);request.put("routingEpoch",invalid);
                refused(()->StatementPublicationMembership.read(data,request),"lineage");assertFalse(data.isInTransaction());
            }
            data.begin(ReadWrite.WRITE);data.deleteAny(CONTROL,uri("urn:rezics:dataset:product"),rv("routingEpoch"),Node.ANY);
            data.add(CONTROL,uri("urn:rezics:dataset:product"),rv("routingEpoch"),NodeFactory.createLiteralString(changedRouting));data.commit();data.end();
            refused(()->StatementPublicationMembership.read(data,eof),"basis");
            refused(()->StatementPublicationMembership.read(data,changed),"seal");assertFalse(data.isInTransaction());
            System.out.println("publication opaque routing UUID admitted_basis_page_eof=true changed_request_control_refused=true invalid_utf8_token_cases=5");
        }finally{dataset.close();}
    }
    @Test public void defaultOnlyPotentialRequiresCurrentReferencePreparationRatherThanFalseEmptyCompletion() throws Exception {
        var dataset=TDB2Factory.connectDataset(pageDirectory().toString());var data=dataset.asDatasetGraph();
        // This exact query is the existing Main readReferences shape: named
        // CURRENT reference custody is distinct from logical CURRENT aliases.
        String query="PREFIX rv: <"+RV+"> PREFIX rdf: <"+RDF.uri+"> "
            +"SELECT ?statement ?subject ?predicate ?key ?head ?app ?type WHERE { "
            +"VALUES ?statement { <"+statement(1).getURI()+"> } "
            +"GRAPH <"+CommandPolicy.CURRENT+"> { ?statement a rdf:Statement ; rv:statementState rv:Active . "
            +"OPTIONAL { ?statement rdf:subject ?subject } OPTIONAL { ?statement rdf:predicate ?predicate } "
            +"OPTIONAL { ?statement rv:meaningKey ?key } OPTIONAL { ?statement rv:head ?head } } "
            +"OPTIONAL { GRAPH <"+CommandPolicy.CURRENT+"> { ?statement rv:applicability ?app } "
            +"OPTIONAL { { GRAPH <"+CommandPolicy.CURRENT+"> { ?app a ?type } } UNION { "
            +"GRAPH <"+CommandPolicy.REVISIONS+"> { ?app a rv:FixedRelease } BIND(rv:FixedRelease AS ?type) } } } }";
        try {
            data.begin(ReadWrite.WRITE);seedControl(data);record(data,statement(1),SUBJECT,head(1),true,false);
            var rows=data.find(CURRENT,statement(1),Node.ANY,Node.ANY);var header=new ArrayList<Quad>();
            try { rows.forEachRemaining(header::add); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            assertEquals(7,header.size());
            data.deleteAny(CURRENT,statement(1),Node.ANY,Node.ANY);
            for(var row:header)data.add(Quad.defaultGraphNodeGenerated,row.getSubject(),row.getPredicate(),row.getObject());
            data.commit();data.end();
            var defaultPage=StatementPublicationMembership.read(data,pageRequest(null,null));
            assertEquals(true,defaultPage.get("complete"));assertEquals(1,defaultPage.get("examined"));
            assertEquals(1,references(defaultPage).size());
            assertEquals(statement(1).getURI(),references(defaultPage).getFirst().get("statementId"));
            data.begin(ReadWrite.READ);
            try(var execution=QueryExecutionFactory.create(query,dataset)) {
                var references=execution.execSelect();assertFalse("Main receiver has no named current witness and must refuse unavailable",references.hasNext());
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,statement(1),RDF.type.asNode(),RDF.Statement.asNode()));
                assertFalse(data.contains(CURRENT,statement(1),Node.ANY,Node.ANY));
            } finally {data.end();}
            System.out.println("publication default-only native_potential_rows=1 named_current_reference_rows=0 disposition=unavailable_until_canonical_preparation");
            // Controlled native preparation moves only these seven exact authored
            // fields. This fixture is not an HTTP raw mutation bypass or handler.
            data.begin(ReadWrite.WRITE);
            for(var row:header) {
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,row.getSubject(),row.getPredicate(),row.getObject()));
                data.delete(Quad.defaultGraphNodeGenerated,row.getSubject(),row.getPredicate(),row.getObject());
                data.add(CURRENT,row.getSubject(),row.getPredicate(),row.getObject());
            }
            data.commit();data.end();
            var namedPage=StatementPublicationMembership.read(data,pageRequest(null,null));
            assertEquals(true,namedPage.get("complete"));assertEquals(1,namedPage.get("examined"));
            assertEquals(references(defaultPage),references(namedPage));
            data.begin(ReadWrite.READ);
            try(var execution=QueryExecutionFactory.create(query,dataset)) {
                var references=execution.execSelect();assertTrue(references.hasNext());var row=references.next();
                assertEquals(statement(1),row.get("statement").asNode());assertEquals(SUBJECT,row.get("subject").asNode());
                assertEquals(rv("classifiedAs"),row.get("predicate").asNode());
                assertEquals(uri("urn:rezics:meaning:"+"a".repeat(64)),row.get("key").asNode());assertEquals(head(1),row.get("head").asNode());
                assertFalse(references.hasNext());assertFalse(data.contains(Quad.defaultGraphNodeGenerated,statement(1),Node.ANY,Node.ANY));
            } finally {data.end();}
            System.out.println("publication prepared native_potential_rows=1 named_current_reference_rows=1 exact_header_fields=7");
        }finally{dataset.close();}
    }
}
