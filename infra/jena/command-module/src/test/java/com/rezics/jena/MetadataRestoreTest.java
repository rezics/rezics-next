package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.Method;
import java.math.BigInteger;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonString;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class MetadataRestoreTest {
    private static final String RV = "https://rezics.com/vocab/", PRODUCT = "urn:rezics:dataset:product";
    private static final String MARKER = "urn:rezics:restore:new-epoch", PREFIX = "urn:rezics:name-migration:metadata-restore:";
    private static final String V1 = "https://rezics.com/definition/work-metadata-details-v1", V2 = "https://rezics.com/definition/work-metadata-details-v2";
    private static final String WORK = id(1), COMPONENT = id(2), MANIFEST = "urn:rezics:sha256:" + "a".repeat(64);
    private record Command(String receipt,String digest,String update,String revision,String original) {}
    private static String id(int value) { return "https://rezics.com/id/00000000-0000-0000-0000-%012d".formatted(value); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static String hash(String value) { return MetadataRestorePolicy.templateDigest(value); }
    private static String quote(String value) { return JSON.toStringFlat(new JsonString(value)); }
    private static String array(String... values) { return java.util.Arrays.stream(values).map(MetadataRestoreTest::quote)
        .collect(java.util.stream.Collectors.joining(",", "[", "]")); }
    @Test public void maintenanceIdentityMatchesTypeScriptCompactJsonVector() {
        assertEquals("fd515bace0a248963f34238146aa032e0aa26c7c5922443c66094644c63b2787",
            command(false,false,900,4,null,20).digest());
    }
    private static String graph(String graph,String facts) { return " GRAPH <" + graph + "> { " + facts + " } "; }
    private static String state(boolean v2,boolean withdrawn) {
        return "{\"kind\":\"edition\",\"id\":\"" + COMPONENT + "\",\"status\":\"" + (withdrawn ? "withdrawn" : "active")
            + "\",\"title\":{\"value\":\"Café edition\",\"language\":\"fr\"},"
            + (v2 ? "\"contentLanguages\":[\"en\",\"fr\"],\"isTranslation\":true,\"originalLanguages\":[\"ja\"],\"titleLanguage\":null,\"tracklistLanguage\":\"fr\","
                : "\"contentLanguage\":\"fr\",")
            + "\"editionStatement\":\"Second edition\",\"publisher\":\"Exact publisher\",\"publicationYear\":2025,\"isbn13\":null}";
    }
    private static Command command(boolean v2,boolean withdrawn,int diagnostic,int main,String predecessor,int revisionNumber) {
        return command(v2,withdrawn,diagnostic,main,predecessor,revisionNumber,state(v2,withdrawn));
    }
    private static Command command(boolean v2,boolean withdrawn,int diagnostic,int main,String predecessor,int revisionNumber,String state) {
        String revision = id(revisionNumber), model = v2 ? V2 : V1;
        String admission = "00000000-0000-0000-0000-%012d".formatted(revisionNumber);
        String sourceReceipt = "urn:rezics:receipt:" + hash(admission + '\0' + "edit-metadata-work");
        String payload = "b".repeat(64);
        String request = "{\"profile\":" + quote(model) + ",\"work\":" + quote(WORK) + ",\"expectedHead\":"
            + (predecessor == null ? "null" : quote(predecessor)) + ",\"state\":" + state + "}";
        String sourceDigest = hash(request);
        String digest = hash(array("held-slim-metadata-restore-v1","new-epoch","9",sourceReceipt,sourceDigest,payload,
            "old-epoch",Integer.toString(diagnostic),Integer.toString(main),COMPONENT,revision));
        String receipt = PREFIX + digest;
        var recorded = JSON.parse(state);
        StringBuilder languageFacts = new StringBuilder();
        if (v2) {
            List<String> content = languageArray(recorded.get("contentLanguages")), originals = languageArray(recorded.get("originalLanguages"));
            if (!content.isEmpty()) languageFacts.append(" ; rv:contentLanguages ").append(quote(String.join(" ",content)));
            if (content.size() == 1) languageFacts.append(" ; rv:editionLanguage ").append(quote(content.getFirst()));
            if (!originals.isEmpty()) languageFacts.append(" ; rv:originalLanguages ").append(quote(String.join(" ",originals)));
            if (recorded.get("isTranslation").getAsBoolean().value()) languageFacts.append(" ; rv:isTranslation \"true\"");
            for (String field : List.of("titleLanguage","tracklistLanguage")) if (!recorded.get(field).isNull())
                languageFacts.append(" ; rv:").append(field).append(' ').append(quote(recorded.get(field).getAsString().value()));
        } else if (!recorded.get("contentLanguage").isNull()) languageFacts.append(" ; rv:editionLanguage ").append(quote(recorded.get("contentLanguage").getAsString().value()));
        String current = "<" + COMPONENT + "> a rv:" + (v2 ? "EditionRecord" : "WorkMetadataComponent")
            + " ; rv:work <" + WORK + "> ; rv:metadataKind \"edition\" ; rv:metadataHead <" + revision
            + "> ; rv:editionState rv:" + (withdrawn ? "Withdrawn" : "Active") + languageFacts + " . <" + WORK + "> rv:editionsRevision <" + revision + "> .";
        String revisions = "<" + revision + "> a rv:" + (v2 ? "WorkMetadataDetailsV2Revision" : "WorkMetadataRevision")
            + ", rv:RevisionAnchor ; rv:component <" + COMPONENT + "> ; rv:metadataState " + quote(state)
            + " ; rv:manifest <" + MANIFEST + "> ; rv:modelRevision <" + model + "> ; rv:shapeRevision <" + model
            + "> ; rv:datasetId <" + PRODUCT + "> ; rv:dataEpoch \"old-epoch\" ; rv:sequence " + diagnostic
            + (predecessor == null ? " ." : " ; rv:predecessor <" + predecessor + "> .");
        String own = "<" + receipt + "> a rv:OperationReceipt ; rv:commandFamily \"metadata-restore-v1\" ; rv:requestDigest " + quote(digest)
            + " ; rv:outcome rv:Succeeded ; rv:datasetId <" + PRODUCT + "> ; rv:dataEpoch \"new-epoch\" ; rv:sequence 0 ; rv:work <" + WORK
            + "> ; rv:sourceReceipt <" + sourceReceipt + "> ; rv:sourceDigest " + quote(sourceDigest) + " ; rv:sourcePayloadDigest " + quote(payload)
            + " ; rv:sourceDataEpoch \"old-epoch\" ; rv:sourceSequence " + diagnostic + " ; rv:sourceMainSequence " + main
            + " ; rv:sourceAdmissionId " + quote(admission) + " ; rv:sourceAuthorityEpoch \"2\" ; rv:sourceScope " + quote("work:edit:" + WORK)
            + " ; rv:sourcePredecessor <" + (predecessor == null ? COMPONENT : predecessor) + "> ; rv:metadataComponent <" + COMPONENT
            + "> ; rv:metadataRevision <" + revision + "> ; rv:metadataManifest <" + MANIFEST + "> ; rv:metadataModel <" + model + "> .";
        String update = "PREFIX rv: <" + RV + "> DELETE { " + graph(CommandPolicy.CONTROL,"<" + MARKER
            + "> rv:reconciledPriorSequence ?last ; rv:reconciledPriorMainSequence ?lastMain .")
            + graph(CommandPolicy.CURRENT,"<" + WORK + "> rv:editionsRevision ?priorEdition .") + " } INSERT { "
            + graph(CommandPolicy.CURRENT,current) + graph(CommandPolicy.REVISIONS,revisions) + graph(CommandPolicy.RECEIPTS,own)
            + graph(CommandPolicy.CONTROL,"<" + MARKER + "> rv:reconciledPriorSequence " + diagnostic + " ; rv:reconciledPriorMainSequence " + main + " .")
            + " } WHERE { " + graph(CommandPolicy.CONTROL,"<" + PRODUCT + "> rv:dataEpoch \"new-epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover <" + MARKER + "> .") + " }";
        return new Command(receipt,digest,update,revision,sourceReceipt);
    }
    private static List<String> languageArray(org.apache.jena.atlas.json.JsonValue value) {
        List<String> result = new java.util.ArrayList<>(); for (var item : value.getAsArray()) result.add(item.getAsString().value()); return result;
    }
    private static DatasetGraph dataset() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { "
            + graph(CommandPolicy.CONTROL,"<" + PRODUCT + "> rv:dataEpoch \"new-epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover <" + MARKER
                + "> . <" + MARKER + "> rv:priorDataEpoch \"old-epoch\" ; rv:priorSequence 800 ; rv:priorMainSequence 3 . <" + CommandInvariant.MAIN_STREAM_SCOPE
                + "> rv:dataEpoch \"new-epoch\" ; rv:streamSequence 0 ; rv:legacyThroughSequence 0 .")
            + graph(CommandPolicy.CURRENT,"<" + WORK + "> a <https://schema.org/CreativeWork> ; rv:head <" + id(10) + "> .") + " }",DatasetFactory.wrap(data));
        data.commit(); data.end(); return data;
    }
    @SuppressWarnings("unchecked")
    private static List<Quad> projection(DatasetGraph logical,Node component,Node revision,Node manifest,Node model) {
        try {
            Method publicFacts = CommandService.class.getDeclaredMethod("editionPublicFacts",DatasetGraph.class,Node.class,Node.class); publicFacts.setAccessible(true);
            List<Quad> facts = new java.util.ArrayList<>();
            var iter = logical.find(uri(CommandPolicy.CURRENT),component,Node.ANY,Node.ANY);
            while (iter.hasNext()) { Quad quad = iter.next(); facts.add(new Quad(Quad.defaultGraphNodeGenerated,quad.asTriple())); }
            facts.addAll((List<Quad>)publicFacts.invoke(null,logical,component,revision));
            facts.add(new Quad(Quad.defaultGraphNodeGenerated,component,uri(RV + "manifest"),manifest));
            facts.add(new Quad(Quad.defaultGraphNodeGenerated,component,uri(RV + "modelRevision"),model));
            return facts;
        } catch (ReflectiveOperationException ex) { throw new IllegalArgumentException(ex); }
    }
    private static MetadataRestorePolicy.Snapshot capture(DatasetGraph data,Command command) {
        return MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),MetadataRestoreTest::projection);
    }
    private static Set<Quad> record(DatasetGraph data,Node graph,Node subject) {
        Set<Quad> result = new HashSet<>(); data.find(graph,subject,Node.ANY,Node.ANY).forEachRemaining(result::add); return result;
    }
    private static DatasetGraph endpointDataset() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        UpdateAction.parseExecute("PREFIX rv: <" + RV + "> INSERT DATA { "
            + graph(CommandPolicy.CURRENT,"<" + WORK + "> rv:mainVersion <urn:test:main> ; rv:continuityProfile <urn:test:continuity> ; rv:descriptiveMetadataHead <urn:test:header> . "
                + "<urn:test:main> a rv:MainVersion ; rv:work <" + WORK + "> ; rv:hostingPolicy rv:MetadataOnly .")
            + graph(CommandPolicy.REVISIONS,"<urn:test:header> a rv:WorkMetadataRevision .") + " }",DatasetFactory.wrap(data));
        data.commit(); data.end(); return data;
    }
    private static org.apache.jena.atlas.json.JsonObject envelope(Command command,ProfileRegistry profiles,boolean v2) {
        var envelope = new org.apache.jena.atlas.json.JsonObject(); envelope.put("receipt",command.receipt()); envelope.put("digest",command.digest());
        envelope.put("update",command.update()); envelope.put("deadlineMs",30_000);
        JsonArray validations = new JsonArray();
        String model = v2 ? V2 : V1, profile = v2 ? "work-metadata-details-v2" : "work-metadata-details-v1";
        for (String[] focus : List.of(new String[]{"work-metadata-details-v1",V1 + "/work-shape",WORK},
            new String[]{profile,model + "/component-shape",COMPONENT},new String[]{profile,model + "/revision-shape",command.revision()})) {
            var validation = new org.apache.jena.atlas.json.JsonObject(); validation.put("profile",focus[0]); validation.put("sha256",profiles.get(focus[0]).sha256());
            validation.put("shape",focus[1]); JsonArray targets = new JsonArray(); targets.add(new JsonString(focus[2])); validation.put("focus",targets);
            JsonArray graphs = new JsonArray(); graphs.add(new JsonString(CommandPolicy.CURRENT)); graphs.add(new JsonString(CommandPolicy.REVISIONS)); validation.put("graphs",graphs);
            validations.add(validation);
        }
        envelope.put("validations",validations); return envelope;
    }
    private static java.net.http.HttpResponse<String> post(int port,org.apache.jena.atlas.json.JsonObject envelope,String bearer) throws Exception {
        var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + "/data/command"))
            .header("Content-Type","application/json").timeout(java.time.Duration.ofSeconds(30));
        if (bearer != null) request.header("Authorization","Bearer " + bearer);
        return java.net.http.HttpClient.newHttpClient().send(request.POST(java.net.http.HttpRequest.BodyPublishers.ofString(JSON.toStringFlat(envelope))).build(),
            java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    @Test public void productionCommandEndpointRequiresMaintenanceAndReplaysExactRestoredMetadata() throws Exception {
        DatasetGraph data = endpointDataset(); ProfileRegistry profiles = SlimCommandTest.profiles();
        var operation = org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","REZICS transactional command");
        var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data",data,false)
            .registerOperation(operation,SlimCommandTest.service(profiles)).addEndpoint("/data","command",operation).build().start();
        try {
            String recorded = state(true,false).replace("[\"en\",\"fr\"]","[\"en-US\",\"sr-Latn\",\"zh-Hans\"]");
            Command command = command(true,false,900,4,null,20,recorded); var request = envelope(command,profiles,true);
            assertEquals(403,post(server.getPort(),request,null).statusCode());
            assertEquals(403,post(server.getPort(),request,"2".repeat(64)).statusCode());
            var first = post(server.getPort(),request,"1".repeat(64)); assertEquals(first.body(),200,first.statusCode());
            var committed = JSON.parse(first.body()); assertEquals(first.body(),"committed",committed.get("status").getAsString().value());
            assertEquals("new-epoch",committed.get("position").getAsObject().get("dataEpoch").getAsString().value());
            assertEquals("0",committed.get("position").getAsObject().get("sequence").getAsString().value());
            assertEquals(first.body(),post(server.getPort(),request,"1".repeat(64)).body());
            var changed = envelope(command,profiles,true); changed.put("update",command.update() + "\n# different restore template");
            assertEquals("conflict",JSON.parse(post(server.getPort(),changed,"1".repeat(64)).body()).get("status").getAsString().value());
            var stalePin = envelope(command,profiles,true); stalePin.get("validations").getAsArray().get(1).getAsObject().put("sha256","f".repeat(64));
            assertEquals("unknown-profile",JSON.parse(post(server.getPort(),stalePin,"1".repeat(64)).body()).get("status").getAsString().value());
            data.begin(ReadWrite.READ);
            try {
                assertTrue(CommandInvariant.readControl(data).held()); assertEquals(BigInteger.valueOf(900),CommandInvariant.readControl(data).cursor());
                assertEquals(BigInteger.valueOf(4),CommandInvariant.readControl(data).mainCursor());
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "contentLanguages"),NodeFactory.createLiteralString("en-US sr-Latn zh-Hans")));
                assertFalse(data.contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),Node.ANY,Node.ANY));
                assertFalse(data.contains(uri(CommandPolicy.OUTBOX),Node.ANY,Node.ANY,Node.ANY));
            } finally { data.end(); }
        } finally { server.stop(); data.close(); }
    }
    private static org.apache.jena.atlas.json.JsonObject rawEnvelope(int diagnostic,int main,boolean paired,String name) {
        String receipt = "urn:rezics:receipt:raw-held:" + name, batch = "urn:rezics:outbox:raw-held:" + name, event = batch + ":event";
        String update = "PREFIX rv: <" + RV + "> DELETE { " + graph(CommandPolicy.CONTROL,"<" + MARKER + "> rv:reconciledPriorSequence ?last ."
            + (paired ? " <" + MARKER + "> rv:reconciledPriorMainSequence ?lastMain ." : "")) + " } INSERT { "
            + graph(CommandPolicy.CONTROL,"<" + MARKER + "> rv:reconciledPriorSequence " + diagnostic + " ."
                + (paired ? " <" + MARKER + "> rv:reconciledPriorMainSequence " + main + " ." : ""))
            + graph(CommandPolicy.RECEIPTS,"<" + receipt + "> a rv:OperationReceipt ; rv:requestDigest " + quote(hash(name))
                + " ; rv:datasetId <" + PRODUCT + "> ; rv:dataEpoch \"old-epoch\" ; rv:sequence " + diagnostic + " ; rv:outcome rv:Succeeded .")
            + graph(CommandPolicy.OUTBOX,"<" + batch + "> a rv:OutboxBatch ; rv:dataEpoch \"old-epoch\" ; rv:sequence " + diagnostic
                + " ; rv:eventCount 1 ; rv:event <" + event + "> . <" + event + "> a rv:WorkEditedEvent ; rv:ordinal 0 ; rv:receipt <" + receipt + "> .")
            + " } WHERE { " + graph(CommandPolicy.CONTROL,"<" + PRODUCT + "> rv:dataEpoch \"new-epoch\" ; rv:routingEpoch \"9\" ; rv:sequence 0 ; rv:restoreHold true ; rv:restoreCutover <" + MARKER
                + "> . OPTIONAL { <" + MARKER + "> rv:reconciledPriorSequence ?last } OPTIONAL { <" + MARKER + "> rv:reconciledPriorMainSequence ?lastMain }") + " }";
        var envelope = new org.apache.jena.atlas.json.JsonObject(); envelope.put("receipt",receipt); envelope.put("digest",hash(name));
        envelope.put("update",update); envelope.put("validations",new JsonArray()); envelope.put("deadlineMs",30_000); return envelope;
    }
    @Test public void productionEndpointComposesSlimAndRawDiagnosticGapsWithoutAdvancingNewMainHead() throws Exception {
        DatasetGraph data = endpointDataset(); data.begin(ReadWrite.WRITE);
        data.deleteAny(uri(CommandPolicy.CONTROL),uri(MARKER),uri(RV + "priorMainSequence"),Node.ANY);
        data.add(uri(CommandPolicy.CONTROL),uri(MARKER),uri(RV + "priorMainSequence"),NodeFactory.createLiteralByValue(1,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        data.commit(); data.end(); ProfileRegistry profiles = SlimCommandTest.profiles();
        var operation = org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command","command","REZICS transactional command");
        var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data",data,false)
            .registerOperation(operation,SlimCommandTest.service(profiles)).addEndpoint("/data","command",operation).build().start();
        try {
            Command first = command(true,false,878,2,null,20);
            var slim = post(server.getPort(),envelope(first,profiles,true),"1".repeat(64)); assertEquals(slim.body(),"committed",JSON.parse(slim.body()).get("status").getAsString().value());
            var raw = post(server.getPort(),rawEnvelope(899,3,true,"paired"),"2".repeat(64)); assertEquals(raw.body(),"committed",JSON.parse(raw.body()).get("status").getAsString().value());
            assertEquals("899",JSON.parse(raw.body()).get("position").getAsObject().get("sequence").getAsString().value());
            var gap = post(server.getPort(),rawEnvelope(901,5,true,"main-gap"),"2".repeat(64)); assertEquals(gap.body(),"invalid",JSON.parse(gap.body()).get("status").getAsString().value());
            var half = post(server.getPort(),rawEnvelope(901,4,false,"half-pair"),"2".repeat(64)); assertEquals(half.body(),"invalid",JSON.parse(half.body()).get("status").getAsString().value());
            Command last = command(true,true,900,4,first.revision(),21);
            var restored = post(server.getPort(),envelope(last,profiles,true),"1".repeat(64)); assertEquals(restored.body(),"committed",JSON.parse(restored.body()).get("status").getAsString().value());
            data.begin(ReadWrite.READ);
            try {
                var control = CommandInvariant.readControl(data); assertTrue(control.held()); assertEquals(BigInteger.ZERO,control.sequence());
                assertEquals(BigInteger.valueOf(900),control.cursor()); assertEquals(BigInteger.valueOf(4),control.mainCursor());
                assertTrue(data.contains(uri(CommandPolicy.OUTBOX),uri("urn:rezics:outbox:raw-held:paired"),uri(RV + "sequence"),NodeFactory.createLiteralByValue(899,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
                assertTrue(data.contains(uri(CommandPolicy.OUTBOX),uri("urn:rezics:outbox:raw-held:paired"),uri(RV + "streamSequence"),NodeFactory.createLiteralByValue(3,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
                assertEquals("0",data.find(uri(CommandPolicy.CONTROL),uri(CommandInvariant.MAIN_STREAM_SCOPE),uri(RV + "streamSequence"),Node.ANY).next().getObject().getLiteralLexicalForm());
                assertFalse(data.contains(uri(CommandPolicy.RECEIPTS),uri("urn:rezics:receipt:raw-held:main-gap"),Node.ANY,Node.ANY));
            } finally { data.end(); }
        } finally { server.stop(); data.close(); }
    }
    @Test public void retiredProofRestorePreservesUnequalPositionsAndKeepsHistoryInOwnerCustody() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command command = command(false,false,900,4,null,20);
            Set<Quad> stream = record(data,uri(CommandPolicy.CONTROL),uri(CommandInvariant.MAIN_STREAM_SCOPE));
            MetadataRestorePolicy.Snapshot snapshot = capture(data,command); assertNull(snapshot.error());
            assertTrue(snapshot.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),Node.ANY));
            MetadataRestorePolicy.apply(data,snapshot); assertNull(MetadataRestorePolicy.check(data,snapshot));
            assertEquals(BigInteger.ZERO,CommandInvariant.readControl(data).sequence());
            assertEquals(BigInteger.valueOf(900),CommandInvariant.readControl(data).cursor());
            assertEquals(stream,record(data,uri(CommandPolicy.CONTROL),uri(CommandInvariant.MAIN_STREAM_SCOPE)));
            assertFalse(data.contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),Node.ANY,Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.original()),Node.ANY,Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.OUTBOX),Node.ANY,Node.ANY,Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),NodeFactory.createLiteralLang("Café edition","fr")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void v2SuccessorWithdrawalUsesExactLocalCasAndRemovesPublicFacts() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command first = command(true,false,900,4,null,20); var one = capture(data,first); assertNull(one.error()); MetadataRestorePolicy.apply(data,one);
            Set<Quad> firstReceipt = record(data,uri(CommandPolicy.RECEIPTS),uri(first.receipt()));
            Command second = command(true,true,950,5,first.revision(),21); var two = capture(data,second); assertNull(two.error()); MetadataRestorePolicy.apply(data,two);
            assertNull(MetadataRestorePolicy.check(data,two));
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "contentLanguages"),NodeFactory.createLiteralString("en fr")));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "metadataHead"),uri(second.revision())));
            assertEquals(firstReceipt,record(data,uri(CommandPolicy.RECEIPTS),uri(first.receipt())));
            assertNotNull(capture(data,command(true,false,951,6,first.revision(),22)).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void interruptedPhysicalRestoreRollsBackAndReusesTheSameSource() {
        DatasetGraph data = dataset(); Command command = command(false,false,900,4,null,20);
        try {
            data.begin(ReadWrite.WRITE); var failed = capture(data,command); assertNull(failed.error());
            DatasetGraph interrupted = new DatasetGraphWrapper(data) {
                @Override public void add(Node graph,Node subject,Node predicate,Node object) {
                    if (subject.equals(uri(COMPONENT)) && predicate.equals(uri(RV + "manifest")))
                        throw new IllegalStateException("injected interrupted metadata persistence");
                    super.add(graph,subject,predicate,object);
                }
            };
            assertThrows(IllegalStateException.class,() -> MetadataRestorePolicy.apply(interrupted,failed)); data.abort(); data.end();
            data.begin(ReadWrite.WRITE); var retry = capture(data,command); assertNull(retry.error()); MetadataRestorePolicy.apply(data,retry); assertNull(MetadataRestorePolicy.check(data,retry));
            assertEquals(command.digest(),data.find(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),Node.ANY).next().getObject().getLiteralLexicalForm());
            data.commit(); data.end();
        } finally { if (data.isInTransaction()) { data.abort(); data.end(); } data.close(); }
    }
    @Test public void savepointSuccessorRetainsUnchangedDefaultAliasFactsAndStagesOnlyExactPhysicalDelta() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command first = command(true,false,900,4,null,20); var initial = capture(data,first); assertNull(initial.error()); MetadataRestorePolicy.apply(data,initial);
            Set<Quad> original = record(data,Quad.defaultGraphNodeGenerated,uri(COMPONENT));
            Command next = command(true,true,950,5,first.revision(),21); var successor = capture(data,next); assertNull(successor.error());
            CommandOverlay primary = new CommandOverlay(data); MetadataRestorePolicy.apply(primary,successor);
            assertNull(MetadataRestorePolicy.check(primary,successor));
            assertEquals(original,record(data,Quad.defaultGraphNodeGenerated,uri(COMPONENT)));
            assertTrue(primary.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "work"),uri(WORK)));
            assertTrue(primary.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "manifest"),uri(MANIFEST)));
            assertTrue(primary.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "modelRevision"),uri(V2)));
            assertFalse(primary.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),Node.ANY));
            assertTrue(primary.removals().stream().noneMatch(q -> q.getSubject().equals(uri(COMPONENT))
                && Set.of(uri(RV + "work"),uri(RV + "manifest"),uri(RV + "modelRevision")).contains(q.getPredicate())));
            assertNull(MembershipNormalFormPolicy.check(primary,SlimCommandTest.profiles(),System.nanoTime() + 30_000_000_000L).error());
            MetadataRestorePolicy.apply(data,successor); assertNull(MetadataRestorePolicy.check(data,successor));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void wrongCursorAuthorityDigestExtraHistoryAndPartialRestoreAreRefused() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command original = command(false,false,900,4,null,20);
            assertNotNull(capture(data,command(false,false,800,4,null,20)).error());
            assertNotNull(capture(data,command(false,false,900,900,null,20)).error());
            for (String altered : List.of(original.update().replace("rv:sourceScope \"work:edit:","rv:sourceScope \"forged:"),
                original.update().replace("rv:sourceAuthorityEpoch \"2\"","rv:sourceAuthorityEpoch \"bad\""),
                original.update().replace("rv:sourceDigest \"","rv:sourceDigest \"0"),
                original.update().replace("Café edition","Different retained state"),
                original.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.REVISIONS,"<" + id(90) + "> a rv:Agent .")),
                original.update().replace("INSERT {", "INSERT { " + graph(CommandPolicy.OUTBOX,"<urn:forged> a rv:OutboxBatch .")))) {
                try { assertNotNull(capture(data,new Command(original.receipt(),original.digest(),altered,original.revision(),original.original())).error()); }
                catch (IllegalArgumentException expected) { /* native closed footprint */ }
            }
            data.add(uri(CommandPolicy.RECEIPTS),uri(original.receipt()),uri(RV + "partial"),NodeFactory.createLiteralString("incomplete"));
            assertNotNull(capture(data,original).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void erasedSourcesMissingSavedMainCutAndOversizedComponentsStayHeld() {
        for (String condition : List.of("erased","missing-main","oversized")) {
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                Command original = command(false,false,900,4,null,20);
                if (condition.equals("erased")) data.add(uri(CommandPolicy.REVISIONS),uri(id(10)),org.apache.jena.vocabulary.RDF.type.asNode(),uri(RV + "ErasedRevision"));
                if (condition.equals("missing-main")) data.deleteAny(uri(CommandPolicy.CONTROL),uri(MARKER),uri(RV + "priorMainSequence"),Node.ANY);
                if (condition.equals("oversized")) for (int index=0;index<65;index++) data.add(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "extra" + index),NodeFactory.createLiteralString("value"));
                assertNotNull(capture(data,original).error());
                assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void competingCasSnapshotsCannotBeAdoptedAfterAnotherRestoreCommits() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Command first = command(false,false,900,4,null,20), other = command(false,false,901,4,null,21);
            var admitted = capture(data,first); assertNull(admitted.error()); assertNull(capture(data,other).error());
            MetadataRestorePolicy.apply(data,admitted);
            assertNotNull(capture(data,other).error());
            assertNotEquals(MetadataRestorePolicy.templateDigest(first.update()),MetadataRestorePolicy.templateDigest(first.update() + "\n"));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void erasedPublishedContentRefusesEditionRestoreBeforeProjection() {
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try {
            Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
            Node variant = uri(id(30)), publication = uri(id(31)), content = uri("urn:rezics:content:revision:00000000-0000-0000-0000-000000000032");
            data.add(current,variant,uri(RV + "resource"),uri(WORK));
            data.add(current,variant,uri(RV + "contentPublicationHead"),publication);
            data.add(revisions,publication,uri(RV + "contentRevision"),content);
            data.add(revisions,content,org.apache.jena.vocabulary.RDF.type.asNode(),uri(RV + "ErasedRevision"));
            boolean[] projected = { false }; Command command = command(false,false,900,4,null,20);
            var result = MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),
                (logical,component,revision,manifest,model) -> { projected[0] = true; return projection(logical,component,revision,manifest,model); });
            assertNotNull(result.error()); assertFalse(projected[0]);
            assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void halfRestoredCursorsAndMissingSavedCutCannotSupplyRecoveryOrder() {
        for (String condition : List.of("diagnostic-only","main-only","missing-saved-main")) {
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                Node control = uri(CommandPolicy.CONTROL), marker = uri(MARKER);
                if (!condition.equals("main-only")) data.add(control,marker,uri(RV + "reconciledPriorSequence"),NodeFactory.createLiteralByValue(850,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                if (!condition.equals("diagnostic-only")) data.add(control,marker,uri(RV + "reconciledPriorMainSequence"),NodeFactory.createLiteralByValue(3,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                if (condition.equals("missing-saved-main")) data.deleteAny(control,marker,uri(RV + "priorMainSequence"),Node.ANY);
                assertNotNull(capture(data,command(false,false,900,4,null,20)).error());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void scriptAndRegionSpellingSurvivesFullV1AndV2RestoreWithOriginalDigests() {
        String v1 = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":\"en-US\"")
            .replace("\"language\":\"fr\"","\"language\":\"zh-Hans\"");
        String v2 = state(true,false).replace("[\"en\",\"fr\"]","[\"en-US\",\"sr-Latn\",\"zh-Hans\"]")
            .replace("[\"ja\"]","[\"sr-Latn\",\"zh-Hans\"]")
            .replace("\"titleLanguage\":null","\"titleLanguage\":\"en-US\"")
            .replace("\"tracklistLanguage\":\"fr\"","\"tracklistLanguage\":\"sr-Latn\"");
        for (boolean revised : List.of(false,true)) {
            String recorded = revised ? v2 : v1; Command command = command(revised,false,900,4,null,20,recorded);
            DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                var restored = capture(data,command); assertNull(restored.error());
                assertTrue(restored.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),NodeFactory.createLiteralString(recorded)));
                MetadataRestorePolicy.apply(data,restored); assertNull(MetadataRestorePolicy.check(data,restored));
                String field = revised ? "contentLanguages" : "editionLanguage";
                String exact = revised ? "en-US sr-Latn zh-Hans" : "en-US";
                assertEquals(exact,data.find(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + field),Node.ANY).next().getObject().getLiteralLexicalForm());
                if (revised) {
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "originalLanguages"),NodeFactory.createLiteralString("sr-Latn zh-Hans")));
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "titleLanguage"),NodeFactory.createLiteralString("en-US")));
                    assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "tracklistLanguage"),NodeFactory.createLiteralString("sr-Latn")));
                } else assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri("https://schema.org/name"),NodeFactory.createLiteralLang("Café edition","zh-Hans")));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "manifest"),uri(MANIFEST)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "modelRevision"),uri(revised ? V2 : V1)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "metadataHead"),uri(command.revision())));
                String sourceDigest = hash("{\"profile\":" + quote(revised ? V2 : V1) + ",\"work\":" + quote(WORK) + ",\"expectedHead\":null,\"state\":" + recorded + "}");
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "sourceDigest"),NodeFactory.createLiteralString(sourceDigest)));
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),NodeFactory.createLiteralString(command.digest())));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void recordedPrivateExtlangGrandfatheredVariantAndExtensionFormsRestoreWithoutNormalization() {
        for (String tag : List.of("x-private","i-default","en-gb-oed","zh-cmn-hans-cn","sl-biske-rozaj","de-DE-1996-u-co-phonebk")) {
            String recorded = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":" + quote(tag));
            Command command = command(false,false,900,4,null,20,recorded); DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                var restored = capture(data,command); assertNull(tag + ": " + restored.error(),restored.error());
                MetadataRestorePolicy.apply(data,restored); assertNull(MetadataRestorePolicy.check(data,restored));
                assertEquals(tag,data.find(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "editionLanguage"),Node.ANY).next().getObject().getLiteralLexicalForm());
                assertTrue(restored.logical().contains(uri(CommandPolicy.REVISIONS),uri(command.revision()),uri(RV + "metadataState"),NodeFactory.createLiteralString(recorded)));
                assertTrue(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),uri(RV + "manifest"),uri(MANIFEST)));
                assertTrue(data.contains(uri(CommandPolicy.RECEIPTS),uri(command.receipt()),uri(RV + "requestDigest"),NodeFactory.createLiteralString(command.digest())));
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void malformedLanguageAndCaseInsensitiveDuplicateVariantsOrSingletonsStayHeldBeforeProjection() {
        for (String tag : List.of("en_US","en--US","en-a","x","a-US","en-abcdefghi","en-US-US"," en-US","en-US ",
            "sl-rozaj-rozaj","sl-rozaj-ROZAJ","en-a-foo-a-bar","en-a-foo-A-bar","en-u-ca-gregory-U-nu-latn")) {
            String recorded = state(false,false).replace("\"contentLanguage\":\"fr\"","\"contentLanguage\":" + quote(tag));
            Command command = command(false,false,900,4,null,20,recorded); DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
            try {
                boolean[] projected = { false };
                var restored = MetadataRestorePolicy.capture(data,command.receipt(),command.digest(),CommandPolicy.parse(command.update(),command.receipt()),
                    (logical,component,revision,manifest,model) -> { projected[0] = true; return projection(logical,component,revision,manifest,model); });
                assertNotNull(tag,restored.error()); assertFalse(tag,projected[0]);
                assertTrue(CommandInvariant.readControl(data).held()); assertNull(CommandInvariant.readControl(data).cursor());
                assertFalse(data.contains(Quad.defaultGraphNodeGenerated,uri(COMPONENT),Node.ANY,Node.ANY));
            } finally { data.abort(); data.end(); data.close(); }
        }
        String duplicates = state(true,false).replace("[\"en\",\"fr\"]","[\"en-US\",\"en-us\"]");
        DatasetGraph data = dataset(); data.begin(ReadWrite.WRITE);
        try { assertNotNull(capture(data,command(true,false,900,4,null,20,duplicates)).error()); }
        finally { data.abort(); data.end(); data.close(); }
    }
}
