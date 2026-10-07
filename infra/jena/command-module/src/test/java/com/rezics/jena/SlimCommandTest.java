package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;

public class SlimCommandTest {
    static final String RV = "https://rezics.com/vocab/", WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    static final String COMPONENT = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    static final String OLD = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    static final String NEW = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    static final String RECEIPT = "urn:rezics:receipt:slim-metadata", DIGEST = "a".repeat(64), PAYLOAD = "b".repeat(64);
    static final String MODEL = "https://rezics.com/definition/work-metadata-details-v1";
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node rv(String value) { return uri(RV + value); }
    static ProfileRegistry profiles() { return ProfileRegistry.load(java.nio.file.Files.isRegularFile(Path.of("profiles/manifest.json"))
        ? Path.of("profiles") : Path.of("../../../generated/model")); }
    static CommandService service(ProfileRegistry profiles) {
        return new CommandService(profiles, "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
    }
    static DatasetGraph dataset() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        UpdateAction.parseExecute("""
            PREFIX rv: <https://rezics.com/vocab/>
            INSERT DATA {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "test" ; rv:routingEpoch "0" ; rv:sequence 0 . }
              GRAPH <urn:rezics:graph:current> {
                <%s> a <https://schema.org/CreativeWork> ; rv:mainVersion <urn:test:main> ; rv:head <urn:test:work-head> ;
                  rv:continuityProfile <urn:test:continuity> ; rv:descriptiveMetadataHead <urn:test:header> ; rv:editionsRevision <%s> .
                <urn:test:main> a rv:MainVersion ; rv:work <%s> ; rv:hostingPolicy rv:MetadataOnly .
                <%s> a rv:WorkMetadataComponent ; rv:work <%s> ; rv:metadataKind "edition" ; rv:metadataHead <%s> ; rv:editionState rv:Active .
              }
              GRAPH <urn:rezics:graph:revisions> {
                <urn:test:header> a rv:WorkMetadataRevision .
                <%s> a rv:WorkMetadataRevision, rv:RevisionAnchor ; rv:component <%s> ; rv:metadataState "{}" ;
                  rv:manifest <urn:rezics:sha256:%s> ; rv:modelRevision <%s> ; rv:shapeRevision <%s> ; rv:dataEpoch "test" ; rv:sequence 1 .
              }
            }
            """.formatted(WORK, OLD, WORK, COMPONENT, WORK, OLD, OLD, COMPONENT, "c".repeat(64), MODEL, MODEL), DatasetFactory.wrap(data));
        data.commit(); data.end(); return data;
    }
    static String update(String receipt, String prior, String next, int sequence) {
        return """
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n }
              GRAPH <urn:rezics:graph:current> { <%s> rv:metadataHead <%s> ; rv:editionState ?oldStatus . <%s> rv:editionsRevision ?oldEditions . }
            }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:current> {
                <%s> a rv:WorkMetadataComponent ; rv:work <%s> ; rv:metadataKind "edition" ; rv:metadataHead <%s> ; rv:editionState rv:Active ; rv:editionLanguage "zh-Hant" .
                <%s> rv:editionsRevision <%s> .
              }
              GRAPH <urn:rezics:graph:revisions> {
                <%s> a rv:WorkMetadataRevision, rv:RevisionAnchor ; rv:component <%s> ; rv:metadataState "{\\"kind\\":\\"edition\\"}" ; rv:predecessor <%s> ;
                  rv:manifest <urn:rezics:sha256:%s> ; rv:modelRevision <%s> ; rv:shapeRevision <%s> ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "test" ; rv:sequence ?next .
              }
              GRAPH <urn:rezics:graph:receipts> {
                <%s> a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:requestDigest "%s" ; rv:admissionId "00000000-0000-4000-8000-000000000005" ;
                  rv:authorityEpoch "0" ; rv:admittedScope "work:edit:%s" ; rv:work <%s> ; rv:metadataComponent <%s> ; rv:metadataRevision <%s> ;
                  rv:workRevision <%s> ; rv:expectedHead <%s> ; rv:action "work.edit" ; rv:commandFamily "work-metadata-details-v1" ;
                  rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "test" ; rv:sequence ?next .
              }
              GRAPH <urn:rezics:graph:outbox> {
                <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "test" ; rv:sequence ?next ; rv:eventCount 1 ; rv:event <%s:event> .
                <%s:event> a rv:WorkMetadataChangedEvent ; rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt <%s> .
              }
            }
            WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "test" ; rv:routingEpoch "0" ; rv:sequence ?n . FILTER(?n = %s) }
              GRAPH <urn:rezics:graph:current> { <%s> rv:head <urn:test:work-head> ; rv:mainVersion <urn:test:main> .
                <%s> rv:metadataHead <%s> . OPTIONAL { <%s> rv:editionState ?oldStatus } OPTIONAL { <%s> rv:editionsRevision ?oldEditions } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:revisions> { <%s> ?p ?o } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:restoreHold true } }
              BIND(?n + 1 AS ?next)
            }
            """.formatted(COMPONENT, prior, WORK, COMPONENT, WORK, next, WORK, next,
                next, COMPONENT, prior, "d".repeat(64), MODEL, MODEL, receipt, DIGEST, WORK, WORK,
                COMPONENT, next, next, prior, receipt, receipt, receipt, receipt, sequence,
                WORK, COMPONENT, prior, COMPONENT, WORK, receipt, next)
            .replace("{\\\"kind\\\":\\\"edition\\\"}", editionState().replace("\"", "\\\""));
    }
    private static String editionState() {
        return "{\"kind\":\"edition\",\"id\":\"" + COMPONENT + "\",\"status\":\"active\","
            + "\"title\":{\"value\":\"A bibliographic title\",\"language\":\"zh-Hant\"},"
            + "\"editionStatement\":\"Second edition\",\"publisher\":\"Publisher\",\"publicationYear\":2025,\"isbn13\":\"9780306406157\"}";
    }
    static List<CommandService.Validation> validations(ProfileRegistry profiles, String revision) {
        return List.of(
            new CommandService.Validation("work-metadata-details-v1", profiles.get("work-metadata-details-v1"),
                MODEL + "/work-shape", List.of(WORK), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
            new CommandService.Validation("work-metadata-details-v1", profiles.get("work-metadata-details-v1"),
                MODEL + "/component-shape", List.of(COMPONENT), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
            new CommandService.Validation("work-metadata-details-v1", profiles.get("work-metadata-details-v1"),
                MODEL + "/revision-shape", List.of(revision), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
    }
    static Map<String, Object> run(CommandService service, DatasetGraph data, ProfileRegistry profiles,
                                   String receipt, String prior, String next, int sequence) {
        return service.runSlim(data, receipt, DIGEST, update(receipt, prior, next, sequence),
            new CommandService.Slim(PAYLOAD, COMPONENT, next), validations(profiles, next),
            System.nanoTime() + 30_000_000_000L);
    }
    @Test public void slimKeepsPublicDefaultFactsFiveQuadProofAndSameLostResponseReceipt() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try {
            var first = run(service, data, profiles, RECEIPT, OLD, NEW, 0);
            assertEquals(first.toString(), "committed", first.get("status"));
            assertEquals(first, run(service, data, profiles, RECEIPT, OLD, NEW, 0));
            data.begin(ReadWrite.READ);
            assertEquals(5, org.apache.jena.atlas.iterator.Iter.count(data.find(uri(CommandPolicy.RECEIPTS), uri(RECEIPT), Node.ANY, Node.ANY)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(COMPONENT), Node.ANY, Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("metadataHead"), uri(NEW)));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("manifest"), uri("urn:rezics:sha256:" + "d".repeat(64))));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("modelRevision"), uri(MODEL)));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), uri("https://schema.org/name"),
                NodeFactory.createLiteralLang("A bibliographic title", "zh-Hant")));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), uri("https://schema.org/isbn"), NodeFactory.createLiteralString("9780306406157")));
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated, Node.ANY, rv("publicTitle"), Node.ANY));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(NEW)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(OLD)));
            assertEquals(1, org.apache.jena.atlas.iterator.Iter.count(data.find(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), Node.ANY)));
            assertFalse(data.contains(uri(CommandPolicy.REVISIONS), uri(NEW), Node.ANY, Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.OUTBOX), Node.ANY, Node.ANY, Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.CONTROL), uri(CommandInvariant.MAIN_STREAM_SCOPE), Node.ANY, Node.ANY));
            data.end();
            assertEquals("conflict", service.runSlim(data, RECEIPT, DIGEST, update(RECEIPT, OLD, NEW, 0),
                new CommandService.Slim("e".repeat(64), COMPONENT, NEW), validations(profiles, NEW), System.nanoTime() + 30_000_000_000L).get("status"));
            String second = NEW + "5";
            assertEquals("committed", run(service, data, profiles, RECEIPT + ":second", NEW, second, 1).get("status"));
            data.begin(ReadWrite.READ);
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(second)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(NEW)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(OLD)));
            assertEquals(1, org.apache.jena.atlas.iterator.Iter.count(data.find(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), Node.ANY)));
            data.end();
        } finally { data.close(); }
    }
    @Test public void withdrawnEditionRemovesPublicBibliographicFactsWhileRetainingItsManifest() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try {
            assertEquals("committed", run(service, data, profiles, RECEIPT, OLD, NEW, 0).get("status"));
            String next = NEW + "9", receipt = RECEIPT + ":withdrawn";
            String withdrawn = update(receipt, NEW, next, 1).replace("rv:editionState rv:Active", "rv:editionState rv:Withdrawn")
                .replace("\\\"status\\\":\\\"active\\\"", "\\\"status\\\":\\\"withdrawn\\\"");
            assertEquals("committed", service.runSlim(data, receipt, DIGEST, withdrawn,
                new CommandService.Slim(PAYLOAD, COMPONENT, next), validations(profiles, next), System.nanoTime() + 30_000_000_000L).get("status"));
            data.begin(ReadWrite.READ);
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), uri("https://schema.org/name"), Node.ANY));
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), uri("https://schema.org/isbn"), Node.ANY));
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("manifest"), Node.ANY));
            data.end();
        } finally { data.close(); }
    }
    @Test public void nativeTdbSuccessorsReplaceTheWorkEditionFenceExactly() throws Exception {
        ProfileRegistry profiles = profiles(); var service = service(profiles);
        Path temporary = Path.of("../../../.temp"); java.nio.file.Files.createDirectories(temporary);
        Path directory = java.nio.file.Files.createTempDirectory(temporary, "slim-edition-fence-");
        var data = org.apache.jena.tdb2.TDB2Factory.connectDataset(directory.toString()).asDatasetGraph();
        try {
            var seed = dataset();
            try {
                seed.begin(ReadWrite.READ); data.begin(ReadWrite.WRITE);
                seed.find().forEachRemaining(data::add);
                data.commit(); data.end(); seed.end();
            } finally { seed.close(); }
            assertEquals("committed", run(service, data, profiles, RECEIPT, OLD, NEW, 0).get("status"));
            data.begin(ReadWrite.READ);
            assertEquals(1, org.apache.jena.atlas.iterator.Iter.count(data.find(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), Node.ANY)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(OLD)));
            data.end();
            String second = NEW + "5";
            assertEquals("committed", run(service, data, profiles, RECEIPT + ":second", NEW, second, 1).get("status"));
            data.begin(ReadWrite.READ);
            assertEquals(1, org.apache.jena.atlas.iterator.Iter.count(data.find(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), Node.ANY)));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(second)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(NEW)));
            assertFalse(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), rv("editionsRevision"), uri(OLD)));
            data.end();
        } finally {
            if (data.isInTransaction()) data.end(); data.close();
            try (var files = java.nio.file.Files.walk(directory)) {
                for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.deleteIfExists(file);
            }
        }
    }
    @Test public void legacyCommandCannotBypassCustodyOrLeaveStalePublicEditionFacts() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try {
            assertEquals("committed", run(service, data, profiles, RECEIPT, OLD, NEW, 0).get("status"));
            String next = NEW + "8", receipt = RECEIPT + ":legacy";
            var rejected = service.runCommand(data, receipt, DIGEST, update(receipt, NEW, next, 1),
                validations(profiles, next), System.nanoTime() + 30_000_000_000L);
            assertEquals("invalid", rejected.get("status"));
            assertTrue(rejected.get("report").toString().contains("slim custody envelope"));
            data.begin(ReadWrite.READ);
            assertEquals("1", CommandInvariant.readControl(data).sequence().toString());
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("metadataHead"), uri(NEW)));
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS), uri(receipt), Node.ANY, Node.ANY));
            data.end();
        } finally { data.close(); }
    }
    @Test public void stalePolicyAndShaclFailuresAbortAllPhysicalWrites() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try {
            assertEquals("guard-unmatched", run(service, data, profiles, RECEIPT, OLD, NEW, 1).get("status"));
            String denied = update(RECEIPT, OLD, NEW, 0).replace("rv:metadataKind \"edition\"", "rv:metadataKind \"header\"");
            assertEquals("invalid", service.runSlim(data, RECEIPT, DIGEST, denied,
                new CommandService.Slim(PAYLOAD, COMPONENT, NEW), validations(profiles, NEW), System.nanoTime() + 30_000_000_000L).get("status"));
            String malformed = update(RECEIPT, OLD, NEW, 0).replace("rv:editionState rv:Active", "rv:editionState rv:Unknown");
            assertEquals("invalid", service.runSlim(data, RECEIPT, DIGEST, malformed,
                new CommandService.Slim(PAYLOAD, COMPONENT, NEW), validations(profiles, NEW), System.nanoTime() + 30_000_000_000L).get("status"));
            String wrongScope = update(RECEIPT, OLD, NEW, 0).replace("work:edit:" + WORK, "work:edit:urn:test:other-work");
            assertEquals("invalid", service.runSlim(data, RECEIPT, DIGEST, wrongScope,
                new CommandService.Slim(PAYLOAD, COMPONENT, NEW), validations(profiles, NEW), System.nanoTime() + 30_000_000_000L).get("status"));
            data.begin(ReadWrite.READ);
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(COMPONENT), rv("metadataHead"), uri(OLD)));
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated, Node.ANY, Node.ANY, Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.RECEIPTS), Node.ANY, Node.ANY, Node.ANY));
            assertFalse(data.contains(uri(CommandPolicy.REVISIONS), uri(NEW), Node.ANY, Node.ANY));
            assertEquals("0", CommandInvariant.readControl(data).sequence().toString()); data.end();
        } finally { data.close(); }
    }
    @Test public void compactSuccessRequiresSuccessfulReceiptAndExactRevisionCasPosition() {
        ProfileRegistry profiles = profiles(); var service = service(profiles);
        String original = update(RECEIPT, OLD, NEW, 0);
        for (String forged : List.of(
            original.replace("rv:outcome rv:Succeeded", "rv:outcome rv:Cancelled"),
            original.replace("rv:predecessor <" + OLD + "> ;", ""),
            original.replace("rv:predecessor <" + OLD + ">", "rv:predecessor <urn:test:header>"),
            original.replace("rv:shapeRevision <" + MODEL + "> ; rv:datasetId <urn:rezics:dataset:product>",
                "rv:shapeRevision <" + MODEL + "> ; rv:datasetId <urn:test:dataset>"),
            original.replace("rv:shapeRevision <" + MODEL + "> ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch \"test\" ; rv:sequence ?next .",
                "rv:shapeRevision <" + MODEL + "> ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch \"other-epoch\" ; rv:sequence 99 ."),
            original.replace("rv:admissionId \"00000000-0000-4000-8000-000000000005\" ;", ""),
            original.replace("rv:authorityEpoch \"0\"", "rv:authorityEpoch \"invalid\""),
            original.replace("rv:action \"work.edit\"", "rv:action \"forged\", \"work.edit\""),
            original.replace("rv:workRevision <" + NEW + ">", "rv:workRevision <" + OLD + ">"))) {
            var data = dataset();
            try {
                var result = service.runSlim(data, RECEIPT, DIGEST, forged,
                    new CommandService.Slim(PAYLOAD, COMPONENT, NEW), validations(profiles, NEW), System.nanoTime() + 30_000_000_000L);
                assertEquals(result.toString(), "invalid", result.get("status"));
                data.begin(ReadWrite.READ);
                assertEquals("0", CommandInvariant.readControl(data).sequence().toString());
                assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(COMPONENT), rv("metadataHead"), uri(OLD)));
                assertNull(CommandInvariant.commitProof(data, RECEIPT));
                assertFalse(data.contains(Quad.defaultGraphNodeGenerated, Node.ANY, Node.ANY, Node.ANY));
                data.end();
            } finally { data.close(); }
        }
    }
    @Test public void slimCommandRejectsAmbiguousPrestateAndOwnerReparenting() {
        ProfileRegistry profiles = profiles(); var service = service(profiles);
        for (boolean ambiguous : List.of(true, false)) {
            var data = dataset();
            try {
                String destination = "https://rezics.com/id/00000000-0000-4000-8000-000000000007";
                data.begin(ReadWrite.WRITE);
                if (ambiguous) data.add(uri(CommandPolicy.CURRENT), uri(COMPONENT), rv("metadataHead"), uri("urn:test:header"));
                else {
                    for (var row : org.apache.jena.atlas.iterator.Iter.toList(data.find(uri(CommandPolicy.CURRENT), uri(WORK), Node.ANY, Node.ANY)))
                        data.add(uri(CommandPolicy.CURRENT), uri(destination), row.getPredicate(), row.getObject());
                }
                data.commit(); data.end();
                String forged = update(RECEIPT, OLD, NEW, 0);
                List<CommandService.Validation> foci = validations(profiles, NEW);
                if (!ambiguous) {
                    forged = forged.replace(WORK, destination).replace("DELETE {",
                        "DELETE { GRAPH <" + CommandPolicy.CURRENT + "> { <" + COMPONENT + "> rv:work <" + WORK + "> } ");
                    var workFocus = foci.getFirst();
                    foci = List.of(new CommandService.Validation(workFocus.profileId(), workFocus.profile(), workFocus.shape(),
                        List.of(destination), workFocus.graphs(), workFocus.binding()), foci.get(1), foci.get(2));
                }
                var result = service.runSlim(data, RECEIPT, DIGEST, forged,
                    new CommandService.Slim(PAYLOAD, COMPONENT, NEW), foci, System.nanoTime() + 30_000_000_000L);
                assertEquals(result.toString(), "invalid", result.get("status"));
                data.begin(ReadWrite.READ);
                assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(COMPONENT), rv("work"), uri(WORK)));
                assertEquals("0", CommandInvariant.readControl(data).sequence().toString());
                assertNull(CommandInvariant.commitProof(data, RECEIPT)); data.end();
            } finally { data.close(); }
        }
    }
    @Test public void compactDigestMustBeRetirableByTheOwnerProtocol() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try {
            assertThrows(IllegalArgumentException.class, () -> service.runSlim(data, RECEIPT, "invalid",
                update(RECEIPT, OLD, NEW, 0), new CommandService.Slim(PAYLOAD, COMPONENT, NEW),
                validations(profiles, NEW), System.nanoTime() + 30_000_000_000L));
            data.begin(ReadWrite.READ);
            assertEquals("0", CommandInvariant.readControl(data).sequence().toString());
            assertNull(CommandInvariant.commitProof(data, RECEIPT)); data.end();
        } finally { data.close(); }
    }
    @Test public void editionV2RetainsItsOwnModelAndFocusedShapes() {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        String model = "https://rezics.com/definition/work-metadata-details-v2";
        try {
            data.begin(ReadWrite.WRITE);
            data.delete(uri(CommandPolicy.CURRENT), uri(COMPONENT), org.apache.jena.vocabulary.RDF.type.asNode(), rv("WorkMetadataComponent"));
            data.add(uri(CommandPolicy.CURRENT), uri(COMPONENT), org.apache.jena.vocabulary.RDF.type.asNode(), rv("EditionRecord"));
            data.delete(uri(CommandPolicy.REVISIONS), uri(OLD), org.apache.jena.vocabulary.RDF.type.asNode(), rv("WorkMetadataRevision"));
            data.add(uri(CommandPolicy.REVISIONS), uri(OLD), org.apache.jena.vocabulary.RDF.type.asNode(), rv("WorkMetadataDetailsV2Revision"));
            for (String property : List.of("modelRevision", "shapeRevision")) {
                data.deleteAny(uri(CommandPolicy.REVISIONS), uri(OLD), rv(property), Node.ANY);
                data.add(uri(CommandPolicy.REVISIONS), uri(OLD), rv(property), uri(model));
            }
            data.commit(); data.end();
            var focuses = List.of(validations(profiles, NEW).getFirst(),
                new CommandService.Validation("work-metadata-details-v2", profiles.get("work-metadata-details-v2"),
                    model + "/component-shape", List.of(COMPONENT), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
                new CommandService.Validation("work-metadata-details-v2", profiles.get("work-metadata-details-v2"),
                    model + "/revision-shape", List.of(NEW), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
            String v2 = update(RECEIPT, OLD, NEW, 0).replace("WorkMetadataComponent", "EditionRecord")
                .replace("WorkMetadataRevision", "WorkMetadataDetailsV2Revision").replace("work-metadata-details-v1", "work-metadata-details-v2");
            var result = service.runSlim(data, RECEIPT, DIGEST, v2, new CommandService.Slim(PAYLOAD, COMPONENT, NEW),
                focuses, System.nanoTime() + 30_000_000_000L);
            assertEquals(result.toString(), "committed", result.get("status"));
            data.begin(ReadWrite.READ);
            assertTrue(data.contains(Quad.defaultGraphNodeGenerated, uri(COMPONENT), rv("modelRevision"), uri(model)));
            data.end();
        } finally { data.close(); }
    }
    @Test public void interruptedPhysicalPersistenceRollsBackAndSameCommandRecovers() {
        ProfileRegistry profiles = profiles(); var service = service(profiles);
        var data = new org.apache.jena.sparql.core.DatasetGraphWrapper(dataset()) {
            boolean interrupt = true;
            @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                if (interrupt && Quad.isDefaultGraph(graph) && predicate.equals(rv("manifest"))) {
                    interrupt = false; throw new IllegalStateException("interrupted persistence");
                }
                super.add(graph, subject, predicate, object);
            }
        };
        try {
            assertThrows(IllegalStateException.class, () -> run(service, data, profiles, RECEIPT, OLD, NEW, 0));
            data.begin(ReadWrite.READ);
            assertEquals("0", CommandInvariant.readControl(data).sequence().toString());
            assertFalse(data.contains(Quad.defaultGraphNodeGenerated, Node.ANY, Node.ANY, Node.ANY));
            assertNull(CommandInvariant.commitProof(data, RECEIPT)); data.end();
            assertEquals("committed", run(service, data, profiles, RECEIPT, OLD, NEW, 0).get("status"));
        } finally { data.close(); }
    }
    @Test public void concurrentCommandsAtOneCasPositionCommitExactlyOne() throws Exception {
        ProfileRegistry profiles = profiles(); var service = service(profiles); var data = dataset();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> run(service, data, profiles, RECEIPT, OLD, NEW, 0));
            var second = pool.submit(() -> run(service, data, profiles, RECEIPT + ":other", OLD, NEW + "6", 0));
            assertEquals(java.util.Set.of("committed", "guard-unmatched"), java.util.Set.of(first.get().get("status"), second.get().get("status")));
        } finally { data.close(); }
    }
}
