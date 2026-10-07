package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Real TDB2/Lucene staging and the production command handler's authenticated held path. */
public class ErasureRestorePolicyTest {
    private static final String RESTORED = "00000000-0000-4000-8000-000000000011";
    private static final String ORIGINAL = "00000000-0000-4000-8000-000000000012";
    private static final String ERASURE = "00000000-0000-4000-8000-000000000013";
    private static final String MARKER = "urn:rezics:restore:" + RESTORED;
    private static final byte[] KEY = "3".repeat(64).getBytes(StandardCharsets.US_ASCII);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS),
        PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), PRIVATE = uri(CommandPolicy.PRIVATE_SEARCH), PRODUCT = uri("urn:rezics:dataset:product");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(int value) { return NodeFactory.createLiteralByValue(java.math.BigInteger.valueOf(value), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static String target(int value) { return "urn:rezics:content:revision:00000000-0000-4000-8000-%012d".formatted(value); }
    private static String hash(String value) throws Exception { return ErasureRestorePolicy.hash(value); }
    private static String strings(List<String> values) { return "[\"" + String.join("\",\"",values) + "\"]"; }
    private static String originalDigest(List<String> targets) throws Exception {
        return hash("{\"family\":\"erasure-graph-v1\",\"erasureId\":\""+ERASURE+"\",\"epoch\":\"7\",\"targets\":"+strings(targets)+"}");
    }
    private static String identity(List<String> targets) throws Exception {
        return hash("[\""+ErasureRestorePolicy.DOMAIN+"\",\""+RESTORED+"\",\"2\",\""+MARKER+"\",\"4\",\""+ORIGINAL+"\",\"9\",\""+originalDigest(targets)+"\",\""+ORIGINAL+"\",\"3\"]");
    }
    private record Command(String receipt, String digest, String update, CommandPolicy.Plan plan, JsonValue proof, List<String> targets) {}
    private static Command command(List<String> targets, List<ErasureRestorePolicy.Key> units) throws Exception {
        String digest=identity(targets), receipt=ErasureRestorePolicy.PREFIX+digest;
        Node own=uri(receipt), original=uri("urn:rezics:receipt:erasure-graph:"+hash(ERASURE));
        Set<Quad> inserts=new HashSet<>();
        for (String target : targets) {
            inserts.add(new Quad(REVISIONS,uri(target),RDF.type.asNode(),rv("ErasedRevision")));
            inserts.add(new Quad(REVISIONS,uri(target),rv("erasureEpoch"),integer(7)));
        }
        addRecord(inserts,RECEIPTS,original,Map.ofEntries(Map.entry(RDF.type.asNode(),rv("OperationReceipt")),
            Map.entry(rv("requestDigest"),text(originalDigest(targets))),Map.entry(rv("datasetId"),PRODUCT),
            Map.entry(rv("dataEpoch"),text(ORIGINAL)),Map.entry(rv("sequence"),integer(9)),Map.entry(rv("outcome"),rv("Succeeded")),
            Map.entry(rv("erasureId"),text(ERASURE)),Map.entry(rv("erasureEpoch"),integer(7))));
        addRecord(inserts,RECEIPTS,own,Map.ofEntries(Map.entry(RDF.type.asNode(),rv("OperationReceipt")),
            Map.entry(rv("commandFamily"),text(ErasureRestorePolicy.DOMAIN)),Map.entry(rv("requestDigest"),text(digest)),
            Map.entry(rv("datasetId"),PRODUCT),Map.entry(rv("dataEpoch"),text(RESTORED)),Map.entry(rv("sequence"),integer(0)),
            Map.entry(rv("outcome"),rv("Succeeded")),Map.entry(rv("restoredReceipt"),original),Map.entry(rv("restoreCutover"),uri(MARKER)),
            Map.entry(rv("erasureId"),text(ERASURE)),Map.entry(rv("erasureEpoch"),integer(7))));
        StringBuilder deletes=new StringBuilder(),where=new StringBuilder("GRAPH <"+CONTROL+"> { <"+PRODUCT+"> <"+rv("dataEpoch")+"> \""+RESTORED+"\" ; <"+rv("routingEpoch")+"> \"2\" ; <"+rv("sequence")+"> 0 ; <"+rv("restoreCutover")+"> <"+MARKER+"> ; <"+rv("restoreHold")+"> true . }");
        int n=0;
        if (!units.isEmpty()) where.append(" { ");
        for (var unit:units) {
            String pattern="GRAPH <"+unit.graph()+"> { <"+unit.subject()+"> ?p"+n+" ?o"+n+" . }";
            deletes.append(pattern);
            if(n!=0)where.append(" UNION ");
            where.append(" { "+pattern+" }");n++;
        }
        if (!units.isEmpty()) where.append(" } ");
        String update="DELETE { "+deletes+" } INSERT { "+quads(inserts)+" } WHERE { "+where+" }";
        return withUpdate(receipt,digest,update,targets);
    }
    private static Command withUpdate(String receipt,String digest,String update,List<String> targets) throws Exception {
        var request=UpdateFactory.create(update);var modify=(org.apache.jena.sparql.modify.request.UpdateModify)request.getOperations().getFirst();
        Set<String> graphs=new HashSet<>(), revisions=new HashSet<>();
        List<Quad> all=new ArrayList<>(modify.getInsertQuads());all.addAll(modify.getDeleteQuads());
        for (Quad q:all) { graphs.add(q.getGraph().getURI());if(q.getGraph().equals(REVISIONS))revisions.add(q.getSubject().getURI()); }
        var plan=new CommandPolicy.Plan(request,graphs,Set.of(),revisions,Set.of(),false,false,!modify.getDeleteQuads().isEmpty());
        String payload="[\""+ErasureRestorePolicy.DOMAIN+"\",\""+receipt+"\",\""+digest+"\",\""+hash(update)+"\",\""+RESTORED+"\",\"2\",\""+MARKER+"\",\"4\",\""+ERASURE+"\",\"7\","+strings(targets)
            +",\""+ORIGINAL+"\",\"9\",\""+originalDigest(targets)+"\",\""+Instant.now().plusSeconds(240)+"\",\""+ORIGINAL+"\",\"3\"]";
        return new Command(receipt,digest,update,plan,sign(payload),targets);
    }
    private static JsonValue sign(String payload) throws Exception {
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(KEY,"HmacSHA256"));
        String signature=HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        var proof=new org.apache.jena.atlas.json.JsonObject();proof.put("payload",payload);proof.put("signature",signature);return proof;
    }
    private static String quads(Set<Quad> values) {
        StringBuilder result=new StringBuilder();
        values.stream().sorted(java.util.Comparator.comparing(Quad::toString)).forEach(q -> result.append("GRAPH ").append(NodeFmtLib.strNT(q.getGraph())).append(" { ")
            .append(NodeFmtLib.strNT(q.getSubject())).append(' ').append(NodeFmtLib.strNT(q.getPredicate())).append(' ').append(NodeFmtLib.strNT(q.getObject())).append(" . } "));
        return result.toString();
    }
    private static void addRecord(Set<Quad> values,Node graph,Node subject,Map<Node,Node> fields) {
        fields.forEach((p,o)->values.add(new Quad(graph,subject,p,o)));
    }
    private static Set<Quad> stored(DatasetGraph data) { Set<Quad> result=new HashSet<>();data.find().forEachRemaining(result::add);return result; }

    private static final class Fixture implements AutoCloseable {
        final DatasetGraphText data;
        final TextIndexLucene index;
        final FilteredGraphTextIndex filtered;
        final Set<Quad> retained=new HashSet<>();
        final List<String> targets;
        final List<ErasureRestorePolicy.Key> units=new ArrayList<>();
        Fixture(int count) throws Exception {
            Path base=Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")),"held-erasure-");
            EntityDefinition definition=new EntityDefinition("uri","label","graph");
            definition.set("body",rv("searchBody"));definition.set("privateBody",rv("privateSearchBody"));definition.setLangField("lang");definition.setUidField("uid");
            TextIndexConfig config=new TextIndexConfig(definition);config.setValueStored(true);
            index=new TextIndexLucene(new ByteBuffersDirectory(),config);filtered=new FilteredGraphTextIndex(index);
            data=new DatasetGraphText(TDB2Factory.connectDataset(base.toString()).asDatasetGraph(),filtered,new TextDocProducerTriples(filtered));
            targets=java.util.stream.IntStream.rangeClosed(1,count).mapToObj(ErasureRestorePolicyTest::target).toList();
            data.begin(ReadWrite.WRITE);
            add(CONTROL,PRODUCT,rv("dataEpoch"),text(RESTORED));add(CONTROL,PRODUCT,rv("routingEpoch"),text("2"));add(CONTROL,PRODUCT,rv("sequence"),integer(0));
            add(CONTROL,PRODUCT,rv("restoreCutover"),uri(MARKER));add(CONTROL,PRODUCT,rv("restoreHold"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
            add(CONTROL,PRODUCT,rv("textIndexGeneration"),uri("urn:rezics:text-index-generation:retained"));
            add(CONTROL,uri(MARKER),RDF.type.asNode(),rv("RestoreCutover"));add(CONTROL,uri(MARKER),rv("dataEpoch"),text(RESTORED));
            add(CONTROL,uri(MARKER),rv("priorDataEpoch"),text(ORIGINAL));add(CONTROL,uri(MARKER),rv("priorSequence"),integer(3));
            add(CONTROL,uri(MARKER),rv("reconciledPriorSequence"),integer(5));
            Node stream=uri(CommandInvariant.MAIN_STREAM_SCOPE);add(CONTROL,stream,rv("dataEpoch"),text(RESTORED));add(CONTROL,stream,rv("streamSequence"),integer(0));
            add(REVISIONS,uri("urn:retained:manifest"),rv("payloadDigest"),text("a".repeat(64)));
            add(REVISIONS,uri("urn:retained:model"),RDF.type.asNode(),rv("ModelGeneration"));add(REVISIONS,uri("urn:retained:model"),rv("manifest"),uri("urn:rezics:sha256:"+"b".repeat(64)));
            CommandInvariant.writeCommitProof(data,"urn:retained:command",new CommandInvariant.CommitProof("d".repeat(64),"c".repeat(64),ORIGINAL,"2","2"));
            data.find(RECEIPTS,uri("urn:retained:command"),Node.ANY,Node.ANY).forEachRemaining(retained::add);
            for (int n=0;n<count;n++) {
                Node graph=n%2==0?PUBLIC:PRIVATE, unit=uri("urn:rezics:held-erasure:unit:"+n);
                units.add(new ErasureRestorePolicy.Key(graph,unit));
                data.add(graph,unit,RDF.type.asNode(),rv("MatchUnit"));data.add(graph,unit,rv(n%2==0?"revision":"contentRevision"),uri(targets.get(n)));
                data.add(graph,unit,rv(n%2==0?"searchBody":"privateSearchBody"),NodeFactory.createLiteralLang("forbidden held payload","en"));
            }
            for (Node graph:List.of(PUBLIC,PRIVATE)) {
                Node unit=uri("urn:rezics:held-erasure:retained:"+(graph.equals(PUBLIC)?"public":"private"));
                add(graph,unit,RDF.type.asNode(),rv("MatchUnit"));add(graph,unit,rv("revision"),uri(target(1000)));
                add(graph,unit,rv(graph.equals(PUBLIC)?"searchBody":"privateSearchBody"),NodeFactory.createLiteralLang("retained unrelated payload","en"));
            }
            data.commit();data.end();
        }
        private void add(Node g,Node s,Node p,Node o) { Quad q=new Quad(g,s,p,o);data.add(q);retained.add(q); }
        ErasureRestorePolicy.Snapshot capture(Command c) { return ErasureRestorePolicy.capture(data,c.plan(),c.receipt(),c.digest(),c.update(),c.proof(),KEY); }
        ErasureRestorePolicy.Snapshot run(Command c,boolean interrupt) {
            data.begin(ReadWrite.WRITE);boolean commit=false;
            try {
                var before=capture(c);if(before.error()!=null) throw new IllegalArgumentException(before.error());
                if(!before.replayed()) {
                    var overlay=new CommandOverlay(data);UpdateAction.execute(c.plan().request(),DatasetFactory.wrap(overlay));
                    String report=ErasureRestorePolicy.check(overlay,before);if(report!=null) throw new IllegalArgumentException(report);
                    overlay.apply();if(interrupt)throw new IllegalStateException("interrupted before commit");
                }
                data.commit();commit=true;return before;
            } finally { if(!commit)data.abort();data.end(); }
        }
        @Override public void close() { data.close();index.close(); }
    }

    @Test public void admittedHeldReplayKeepsSequenceCursorEpochCustodyAndDirectPublicPrivateText() throws Exception {
        try(Fixture f=new Fixture(64)) {
            Command c=command(f.targets,f.units);f.data.begin(ReadWrite.READ);var control=CommandInvariant.readControl(f.data);f.data.end();
            assertFalse(f.run(c,false).replayed());
            f.data.begin(ReadWrite.READ);
            assertEquals(control,CommandInvariant.readControl(f.data));assertTrue(stored(f.data).containsAll(f.retained));
            assertEquals(new CommandInvariant.CommitProof("d".repeat(64),"c".repeat(64),ORIGINAL,"2","2"),CommandInvariant.commitProof(f.data,"urn:retained:command"));
            for(String target:f.targets)assertTrue(f.data.contains(REVISIONS,uri(target),rv("erasureEpoch"),integer(7)));
            assertEquals(integer(0),f.data.find(RECEIPTS,uri(c.receipt()),rv("sequence"),Node.ANY).next().getObject());
            f.data.end();
            assertTrue(f.filtered.query(rv("searchBody"),"forbidden",PUBLIC.getURI(),null,100).isEmpty());
            assertTrue(f.filtered.query(rv("privateSearchBody"),"forbidden",PRIVATE.getURI(),null,100).isEmpty());
            assertEquals(1,f.filtered.query(rv("searchBody"),"retained",PUBLIC.getURI(),null,100).size());
            assertEquals(1,f.filtered.query(rv("privateSearchBody"),"retained",PRIVATE.getURI(),null,100).size());
            assertTrue(f.run(c,false).replayed());
            // The existing release invariant still accepts sequence zero; no
            // cursor or hold-clear exception is needed in the kernel invariant.
            String releaseReceipt="urn:rezics:receipt:restore-release:"+hash(RESTORED), releaseDigest=hash("release");
            String release="DELETE { GRAPH <"+CONTROL+"> { <"+PRODUCT+"> <"+rv("restoreHold")+"> true } } INSERT { GRAPH <"+RECEIPTS+"> { <"+releaseReceipt+"> a <"+rv("OperationReceipt")+"> ; <"+rv("requestDigest")+"> \""+releaseDigest+"\" ; <"+rv("datasetId")+"> <"+PRODUCT+"> ; <"+rv("dataEpoch")+"> \""+RESTORED+"\" ; <"+rv("sequence")+"> 0 . } } WHERE { GRAPH <"+CONTROL+"> { <"+PRODUCT+"> <"+rv("dataEpoch")+"> \""+RESTORED+"\" ; <"+rv("routingEpoch")+"> \"2\" ; <"+rv("sequence")+"> 0 } }";
            var releasePlan=CommandPolicy.parse(release,releaseReceipt);
            f.data.begin(ReadWrite.WRITE);
            var beforeRelease=CommandInvariant.readControl(f.data);
            var released=new CommandOverlay(f.data);UpdateAction.execute(releasePlan.request(),DatasetFactory.wrap(released));
            assertNull(CommandInvariant.check(released,releaseReceipt,releaseDigest,releasePlan,beforeRelease));
            assertFalse(CommandInvariant.readControl(released).held());
            released.apply();f.data.commit();f.data.end();
        }
    }

    private static org.apache.jena.atlas.json.JsonObject envelope(Command command,JsonValue proof) {
        var envelope = new org.apache.jena.atlas.json.JsonObject(); envelope.put("receipt",command.receipt()); envelope.put("digest",command.digest());
        envelope.put("update",command.update()); envelope.put("validations",new org.apache.jena.atlas.json.JsonArray()); envelope.put("deadlineMs",30_000);
        if (proof != null) envelope.put("titleAdmission",proof); return envelope;
    }
    private static java.net.http.HttpResponse<String> post(int port,org.apache.jena.atlas.json.JsonObject envelope,String bearer) throws Exception {
        var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + "/data/command"))
            .header("Content-Type","application/json").timeout(java.time.Duration.ofSeconds(30));
        if (bearer != null) request.header("Authorization","Bearer " + bearer);
        return java.net.http.HttpClient.newHttpClient().send(request.POST(java.net.http.HttpRequest.BodyPublishers.ofString(JSON.toStringFlat(envelope))).build(),
            java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    private static org.apache.jena.atlas.json.JsonObject retirement() throws Exception {
        var unsigned = new CommandService.Retirement("urn:retained:command","d".repeat(64),"c".repeat(64),ORIGINAL,"2","2","");
        var signature = sign(CommandService.retirementPayload(unsigned)).getAsObject().get("signature").getAsString().value();
        var fields = new org.apache.jena.atlas.json.JsonObject(); fields.put("receipt",unsigned.receipt()); fields.put("digest",unsigned.digest());
        fields.put("payloadSha256",unsigned.payloadSha256()); fields.put("dataEpoch",unsigned.dataEpoch()); fields.put("sequence",unsigned.sequence());
        fields.put("streamSequence",unsigned.streamSequence()); fields.put("signature",signature);
        var envelope = new org.apache.jena.atlas.json.JsonObject(); envelope.put("retireProof",fields); return envelope;
    }
    @Test public void productionCommandEndpointRequiresMaintenanceFreshErasureProofAndNormalRetirementRules() throws Exception {
        try (Fixture fixture = new Fixture(2)) {
            var operation = org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","REZICS transactional command");
            var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data",fixture.data,false)
                .registerOperation(operation,SlimCommandTest.service(SlimCommandTest.profiles())).addEndpoint("/data","command",operation).build().start();
            try {
                Command command = command(fixture.targets,fixture.units);
                assertEquals(403,post(server.getPort(),envelope(command,command.proof()),null).statusCode());
                assertEquals(403,post(server.getPort(),envelope(command,command.proof()),"2".repeat(64)).statusCode());
                var unsigned = post(server.getPort(),envelope(command,null),"1".repeat(64));
                assertEquals(unsigned.body(),"invalid",JSON.parse(unsigned.body()).get("status").getAsString().value());
                var first = post(server.getPort(),envelope(command,command.proof()),"1".repeat(64)); assertEquals(first.body(),200,first.statusCode());
                assertEquals(first.body(),"committed",JSON.parse(first.body()).get("status").getAsString().value());
                assertTrue(fixture.filtered.query(rv("searchBody"),"forbidden",PUBLIC.getURI(),null,100).isEmpty());
                assertTrue(fixture.filtered.query(rv("privateSearchBody"),"forbidden",PRIVATE.getURI(),null,100).isEmpty());
                Command renewed = withUpdate(command.receipt(),command.digest(),command.update(),command.targets());
                assertEquals(first.body(),post(server.getPort(),envelope(renewed,renewed.proof()),"1".repeat(64)).body());
                String payload = renewed.proof().getAsObject().get("payload").getAsString().value();
                String expired = payload.replace(JSON.parseAny(payload).getAsArray().get(14).getAsString().value(),"2000-01-01T00:00:00Z");
                var stale = post(server.getPort(),envelope(renewed,sign(expired)),"1".repeat(64));
                assertEquals(stale.body(),"invalid",JSON.parse(stale.body()).get("status").getAsString().value());
                var heldRetirement = post(server.getPort(),retirement(),"2".repeat(64));
                assertEquals(heldRetirement.body(),"invalid",JSON.parse(heldRetirement.body()).get("status").getAsString().value());
                String releaseReceipt = "urn:rezics:receipt:restore-release:" + hash(RESTORED), releaseDigest = hash("http-release");
                String release = "DELETE { GRAPH <" + CONTROL + "> { <" + PRODUCT + "> <" + rv("restoreHold") + "> true } } INSERT { GRAPH <" + RECEIPTS
                    + "> { <" + releaseReceipt + "> a <" + rv("OperationReceipt") + "> ; <" + rv("requestDigest") + "> " + JSON.toStringFlat(new org.apache.jena.atlas.json.JsonString(releaseDigest))
                    + " ; <" + rv("datasetId") + "> <" + PRODUCT + "> ; <" + rv("dataEpoch") + "> \"" + RESTORED + "\" ; <" + rv("sequence") + "> 0 . } } WHERE { GRAPH <" + CONTROL
                    + "> { <" + PRODUCT + "> <" + rv("dataEpoch") + "> \"" + RESTORED + "\" ; <" + rv("routingEpoch") + "> \"2\" ; <" + rv("sequence") + "> 0 . } }";
                var releaseEnvelope = new org.apache.jena.atlas.json.JsonObject(); releaseEnvelope.put("receipt",releaseReceipt); releaseEnvelope.put("digest",releaseDigest);
                releaseEnvelope.put("update",release); releaseEnvelope.put("validations",new org.apache.jena.atlas.json.JsonArray()); releaseEnvelope.put("deadlineMs",30_000);
                var released = post(server.getPort(),releaseEnvelope,"1".repeat(64)); assertEquals(released.body(),"committed",JSON.parse(released.body()).get("status").getAsString().value());
                Command afterRelease = withUpdate(command.receipt(),command.digest(),command.update(),command.targets());
                var denied = post(server.getPort(),envelope(afterRelease,afterRelease.proof()),"1".repeat(64));
                assertEquals(denied.body(),"invalid",JSON.parse(denied.body()).get("status").getAsString().value());
                assertEquals(403,post(server.getPort(),retirement(),"1".repeat(64)).statusCode());
                var retired = post(server.getPort(),retirement(),"2".repeat(64)); assertEquals(retired.body(),"retired",JSON.parse(retired.body()).get("status").getAsString().value());
                fixture.data.begin(ReadWrite.READ);
                try {
                    assertFalse(CommandInvariant.readControl(fixture.data).held()); assertNull(CommandInvariant.commitProof(fixture.data,"urn:retained:command"));
                    assertEquals(java.math.BigInteger.ZERO,CommandInvariant.readControl(fixture.data).sequence());
                    assertEquals(java.math.BigInteger.valueOf(5),CommandInvariant.readControl(fixture.data).cursor());
                    assertEquals(integer(9),fixture.data.find(RECEIPTS,uri("urn:rezics:receipt:erasure-graph:" + hash(ERASURE)),rv("sequence"),Node.ANY).next().getObject());
                    assertTrue(fixture.data.contains(REVISIONS,uri("urn:retained:model"),RDF.type.asNode(),rv("ModelGeneration")));
                } finally { fixture.data.end(); }
            } finally { server.stop(); }
        }
    }
    @Test public void nonheldForeignStaleUnsignedMixedAndOversizedInputsDenyWithoutMutation() throws Exception {
        try(Fixture f=new Fixture(2)) {
            Command c=command(f.targets,f.units);
            f.data.begin(ReadWrite.WRITE);Set<Quad> baseline=stored(f.data);
            assertNotNull(ErasureRestorePolicy.capture(f.data,c.plan(),c.receipt(),c.digest(),c.update(),null,KEY).error());
            String payload=c.proof().getAsObject().get("payload").getAsString().value();
            for(String altered:List.of(payload.replace("rezics-erasure-restore-v1","other-admission-v1"),payload.replace(MARKER,"urn:rezics:restore:foreign"),
                payload.replace(originalDigest(f.targets),"f".repeat(64)))) {
                // Malformed/foreign signed claims fail before writes.
                assertNotNull(ErasureRestorePolicy.capture(f.data,c.plan(),c.receipt(),c.digest(),c.update(),sign(altered),KEY).error());
            }
            String expired=payload.replace(JSON.parseAny(payload).getAsArray().get(14).getAsString().value(),"2000-01-01T00:00:00Z");
            assertNotNull(ErasureRestorePolicy.capture(f.data,c.plan(),c.receipt(),c.digest(),c.update(),sign(expired),KEY).error());
            f.data.deleteAny(CONTROL,PRODUCT,rv("restoreHold"),Node.ANY);assertNotNull(f.capture(c).error());
            f.data.abort();f.data.end();
            f.data.begin(ReadWrite.READ);assertEquals(baseline,stored(f.data));f.data.end();
            Command mixed=command(List.of(f.targets.get(0),"urn:rezics:work:revision:foreign"),f.units);
            assertThrows(IllegalArgumentException.class,()->f.run(mixed,false));
            List<String> many=java.util.stream.IntStream.rangeClosed(1,65).mapToObj(ErasureRestorePolicyTest::target).toList();
            Command large=command(many,List.of());assertThrows(IllegalArgumentException.class,()->f.run(large,false));
        }
    }
    @Test public void unrelatedWildcardPartialSharedAndRetargetedUnitFootprintsDeny() throws Exception {
        try(Fixture f=new Fixture(2)) {
            Command c=command(f.targets,f.units);
            for(String update:List.of(c.update().replace("<urn:rezics:held-erasure:unit:0>","?foreign"),
                c.update().replace("?p0 ?o0","<https://rezics.com/vocab/revision> ?o0"),
                c.update().replace(f.targets.get(0),target(999)),
                c.update().substring(0,c.update().length()-1)+" FILTER(?p0 != <https://rezics.com/vocab/searchBody>) }",
                c.update().replace(" UNION ", " "))) {
                Command bad=withUpdate(c.receipt(),c.digest(),update,c.targets());assertThrows(IllegalArgumentException.class,()->f.run(bad,false));
            }
            f.data.begin(ReadWrite.WRITE);f.data.add(PUBLIC,f.units.get(0).subject(),rv("contentRevision"),uri(target(1000)));f.data.commit();f.data.end();
            assertThrows(IllegalArgumentException.class,()->f.run(c,false));
            f.data.begin(ReadWrite.WRITE);f.data.deleteAny(PUBLIC,f.units.get(0).subject(),rv("contentRevision"),Node.ANY);
            f.data.add(PRIVATE,uri("urn:rezics:held-erasure:raced"),rv("revision"),uri(f.targets.get(0)));f.data.commit();f.data.end();
            assertThrows(IllegalArgumentException.class,()->f.run(c,false));
        }
    }
    @Test public void partialProofAndReplayAfterReleaseCannotUseDigestOnlySuccess() throws Exception {
        try(Fixture f=new Fixture(2)) {
            Command c=command(f.targets,f.units);f.run(c,false);
            f.data.begin(ReadWrite.WRITE);f.data.deleteAny(REVISIONS,uri(f.targets.get(1)),rv("erasureEpoch"),Node.ANY);f.data.commit();f.data.end();
            assertThrows(IllegalArgumentException.class,()->f.run(c,false));
            f.data.begin(ReadWrite.WRITE);f.data.add(REVISIONS,uri(f.targets.get(1)),rv("erasureEpoch"),integer(7));
            f.data.add(PRIVATE,uri("urn:rezics:held-erasure:stale"),rv("revision"),uri(f.targets.get(0)));f.data.commit();f.data.end();
            assertThrows(IllegalArgumentException.class,()->f.run(c,false));
            f.data.begin(ReadWrite.WRITE);f.data.deleteAny(PRIVATE,uri("urn:rezics:held-erasure:stale"),Node.ANY,Node.ANY);
            f.data.deleteAny(CONTROL,PRODUCT,rv("restoreHold"),Node.ANY);f.data.commit();f.data.end();
            assertThrows(IllegalArgumentException.class,()->f.run(c,false));
        }
    }
    @Test public void interruptedNativeTransactionRollsBackBeforeRecoverySafeRetry() throws Exception {
        try(Fixture f=new Fixture(2)) {
            Command c=command(f.targets,f.units);f.data.begin(ReadWrite.READ);Set<Quad> baseline=stored(f.data);f.data.end();
            assertThrows(IllegalStateException.class,()->f.run(c,true));
            f.data.begin(ReadWrite.READ);assertEquals(baseline,stored(f.data));f.data.end();
            assertEquals(1,f.filtered.query(rv("searchBody"),"forbidden",PUBLIC.getURI(),null,100).size());
            assertEquals(1,f.filtered.query(rv("privateSearchBody"),"forbidden",PRIVATE.getURI(),null,100).size());
            assertFalse(f.run(c,false).replayed());assertTrue(f.run(c,false).replayed());
        }
    }
}
