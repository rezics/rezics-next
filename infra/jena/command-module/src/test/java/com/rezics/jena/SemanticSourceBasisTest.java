package com.rezics.jena;

import static org.junit.Assert.*;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Actual TDB2/source fixtures; no adoption or reader-activation claim. */
public class SemanticSourceBasisTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static Node integer(String value) { return NodeFactory.createLiteralByValue(new java.math.BigInteger(value), XSDDatatype.XSDinteger); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product"),
        RESOURCE = uri("http://www.w3.org/2000/01/rdf-schema#Resource"), NUMBER = uri("https://schema.org/episodeNumber"),
        ALIAS = uri("https://schema.org/alternateName"), SOURCE = id(1), HEAD = id(2), OTHER = id(3), OTHER_HEAD = id(4);
    private static void replace(DatasetGraph data, Node graph, Node subject, Node predicate, Node value) {
        data.deleteAny(graph, subject, predicate, Node.ANY);
        if (value != null) data.add(graph, subject, predicate, value);
    }
    private static String sha(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (Exception ex) { throw new AssertionError(ex); }
    }
    private static long count(CommandWork work, String name) {
        var match = java.util.regex.Pattern.compile("(?:^|,)" + name + "=([0-9]+)").matcher(work.counters());
        return match.find() ? Long.parseLong(match.group(1)) : 0;
    }
    private static void unavailable(Runnable operation) {
        try { operation.run(); fail("unavailable source must not certify scalar absence"); }
        catch (IllegalStateException expected) { assertNotNull(expected.getMessage()); }
    }
    private static final class Fixture implements AutoCloseable {
        final Path directory;
        DatasetGraph data;
        final Node manifest;
        final byte[] payload, manifestBytes;
        Fixture() {
            try {
                directory = Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")), "semantic-source-");
                data = TDB2Factory.connectDataset(directory.resolve("tdb").toString()).asDatasetGraph();
                // These are the existing owner's exact immutable formats. Native
                // proof returns their reference, never a guessed numeric lexical.
                payload = ("{\"format\":\"rezics-component-v1\",\"component\":\"" + SOURCE.getURI()
                    + "\",\"state\":{\"component\":\"resource\",\"types\":[\"https://schema.org/Episode\"],"
                    + "\"lifecycle\":\"active\",\"properties\":[{\"predicate\":\"https://schema.org/episodeNumber\","
                    + "\"value\":{\"kind\":\"integer\",\"lexical\":\"0\"}}]}}") .getBytes(StandardCharsets.UTF_8);
                manifestBytes = ("{\"format\":\"rezics-manifest-v1\",\"component\":\"" + SOURCE.getURI()
                    + "\",\"payload\":\"sha256:" + sha(payload) + "\",\"payloadBytes\":" + payload.length
                    + ",\"mediaType\":\"application/json\",\"model\":\"https://rezics.com/definition/semantic-resource-v1\","
                    + "\"shape\":\"https://rezics.com/definition/semantic-resource-v1\"}").getBytes(StandardCharsets.UTF_8);
                Files.write(directory.resolve(sha(payload)), payload);
                Files.write(directory.resolve(sha(manifestBytes)), manifestBytes);
                manifest = uri("urn:rezics:sha256:" + sha(manifestBytes));
                raw(d -> {
                    d.add(CONTROL, PRODUCT, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
                    d.add(CONTROL, PRODUCT, p("routingEpoch"), text("22222222-2222-4222-8222-222222222222"));
                    d.add(CONTROL, PRODUCT, p("sequence"), integer("1"));
                    resource(d, SOURCE, HEAD); resource(d, OTHER, OTHER_HEAD);
                    d.add(CURRENT, SOURCE, NUMBER, integer("0"));
                });
            } catch (Exception ex) { throw new AssertionError(ex); }
        }
        void resource(DatasetGraph d, Node resource, Node revision) {
            Node retained = manifest;
            if (!SOURCE.equals(resource)) {
                try {
                    byte[] state = ("{\"format\":\"rezics-component-v1\",\"component\":\"" + resource.getURI()
                        + "\",\"state\":{\"component\":\"resource\",\"types\":[\"https://schema.org/Episode\"],"
                        + "\"lifecycle\":\"active\",\"properties\":[]}}").getBytes(StandardCharsets.UTF_8);
                    byte[] root = ("{\"format\":\"rezics-manifest-v1\",\"component\":\"" + resource.getURI()
                        + "\",\"payload\":\"sha256:" + sha(state) + "\",\"payloadBytes\":" + state.length
                        + ",\"mediaType\":\"application/json\",\"model\":\"https://rezics.com/definition/semantic-resource-v1\","
                        + "\"shape\":\"https://rezics.com/definition/semantic-resource-v1\"}").getBytes(StandardCharsets.UTF_8);
                    Files.write(directory.resolve(sha(state)), state); Files.write(directory.resolve(sha(root)), root);
                    retained = uri("urn:rezics:sha256:" + sha(root));
                } catch (Exception ex) { throw new AssertionError(ex); }
            }
            d.add(CURRENT, resource, RDF.type.asNode(), RESOURCE);
            d.add(CURRENT, resource, RDF.type.asNode(), uri("https://schema.org/Episode"));
            d.add(CURRENT, resource, p("semanticHead"), revision);
            d.add(REVISIONS, revision, RDF.type.asNode(), p("SemanticRevision"));
            d.add(REVISIONS, revision, RDF.type.asNode(), p("RevisionAnchor"));
            d.add(REVISIONS, revision, p("component"), resource);
            d.add(REVISIONS, revision, p("lifecycle"), p("Active"));
            d.add(REVISIONS, revision, p("operation"), id(5));
            d.add(REVISIONS, revision, p("manifest"), retained);
            d.add(REVISIONS, revision, p("modelGeneration"), uri("urn:rezics:model-generation:" + "a".repeat(64)));
            d.add(REVISIONS, revision, p("modelRevision"), uri("https://rezics.com/definition/semantic-resource-v1"));
            d.add(REVISIONS, revision, p("shapeRevision"), uri("https://rezics.com/definition/semantic-resource-v1"));
            d.add(REVISIONS, revision, p("datasetId"), PRODUCT);
            d.add(REVISIONS, revision, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
            d.add(REVISIONS, revision, p("sequence"), integer("1"));
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ);
            try { return operation.get(); } finally { data.end(); }
        }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T value = operation.get(); data.commit(); return value; }
            catch (RuntimeException | Error failure) {
                // NIO abort/end may write the TDB journal. Preserve cancellation
                // while shielding that cleanup from Java's interrupt-close rule.
                boolean interrupted = Thread.interrupted();
                try { data.abort(); data.end(); }
                finally { if (interrupted) Thread.currentThread().interrupt(); }
                throw failure;
            }
            finally { if (data.isInTransaction()) data.end(); }
        }
        void raw(Consumer<DatasetGraph> operation) { write(() -> { operation.accept(data); return null; }); }
        void rawMaintenance(Consumer<DatasetGraph> operation) {
            raw(d -> {
                operation.accept(d);
                var request = org.apache.jena.update.UpdateFactory.create("# trailing raw maintenance comment\n");
                TemplateIndexService.appendRawInvalidations(request);
                org.apache.jena.update.UpdateAction.parseExecute(request.toString(), d);
            });
        }
        void qualify() { write(() -> { SemanticSourceBasis.qualifyAtStartup(data, Long.MAX_VALUE); return null; }); }
        void nativeWrite(Consumer<DatasetGraph> operation) {
            write(() -> {
                var capture = new SearchDeltaJournal.Capture(data);
                capture.sourceDeadline(Long.MAX_VALUE);
                operation.accept(capture.observed());
                capture.finishSemanticSources(Long.MAX_VALUE);
                SemanticSourceBasis.check(Long.MAX_VALUE);
                return null;
            });
        }
        SemanticSourceBasis.Proof proof() { return proof(data, SOURCE, NUMBER); }
        SemanticSourceBasis.Proof proof(DatasetGraph selected, Node resource, Node predicate) {
            return read(() -> SemanticSourceBasis.proof(selected, resource, predicate, Long.MAX_VALUE));
        }
        void originals() {
            try {
                assertArrayEquals(payload, Files.readAllBytes(directory.resolve(sha(payload))));
                assertArrayEquals(manifestBytes, Files.readAllBytes(directory.resolve(sha(manifestBytes))));
                assertEquals(manifest, read(() -> {
                    var values = data.find(REVISIONS, HEAD, p("manifest"), Node.ANY);
                    try { return values.next().getObject(); } finally { Iter.close(values); }
                }));
            } catch (Exception ex) { throw new AssertionError(ex); }
        }
        void reopen() {
            TDBInternal.expel(data);
            data = TDB2Factory.connectDataset(directory.resolve("tdb").toString()).asDatasetGraph();
        }
        @Override public void close() { TDBInternal.expel(data); }
    }
    private static class Measured extends DatasetGraphWrapper {
        long probes, rows;
        Measured(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            assertNotEquals("source operation must fix its graph", Node.ANY, graph);
            assertNotEquals("source operation must fix its subject", Node.ANY, subject);
            assertNotEquals("source operation must fix its predicate", Node.ANY, predicate);
            probes++;
            return Iter.map(super.find(graph, subject, predicate, object), value -> { rows++; return value; });
        }
        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
            var rows = find(graph, subject, predicate, object);
            try { if (!rows.hasNext()) return false; rows.next(); return true; } finally { Iter.close(rows); }
        }
    }
    /** Instrument each actual B-tree range iterator used by TDB point lookup. */
    private static long[] physical(DatasetGraph data) {
        var table = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getQuadTable().getNodeTupleTable().getTupleTable();
        long[] counts = {0, 0};
        for (int i = 0; i < table.numIndexes(); i++) {
            var original = table.getIndex(i);
            var record = (TupleIndexRecord) original.baseTupleIndex();
            var range = (org.apache.jena.dboe.index.RangeIndex) Proxy.newProxyInstance(
                org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(), new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
                (proxy, method, args) -> {
                    Object result = method.invoke(record.getRangeIndex(), args);
                    if (method.getName().equals("iterator")) {
                        counts[0]++;
                        return Iter.map((Iterator<?>) result, value -> { counts[1]++; return value; });
                    }
                    return result;
                });
            table.setTupleIndex(i, new TupleIndexRecord(4, original.getMapping(), "source-measured-" + i, range.getRecordFactory(), range));
        }
        return counts;
    }
    @Test public void qualificationIsMandatoryAndZeroIsPresentRatherThanAbsence() {
        try (Fixture f = new Fixture()) {
            unavailable(f::proof);
            f.qualify();
            var present = f.proof();
            assertTrue(present.projectionHasScalar()); assertEquals(HEAD, present.revision()); assertEquals(f.manifest, present.manifest());
            var knownAbsent = f.proof(f.data, OTHER, NUMBER);
            assertFalse(knownAbsent.projectionHasScalar()); assertEquals(OTHER_HEAD, knownAbsent.revision());
            assertNotEquals(present.manifest(), knownAbsent.manifest());
            f.nativeWrite(d -> replace(d, CURRENT, SOURCE, NUMBER, null));
            var absent = f.proof();
            assertFalse(absent.projectionHasScalar()); assertNotEquals(present.token(), absent.token());
            assertEquals(present.manifest(), absent.manifest()); f.originals();
            f.nativeWrite(d -> replace(d, CURRENT, SOURCE, NUMBER, text("special")));
            assertNotEquals(absent.token(), f.proof().token()); f.originals();
        }
    }
    @Test public void directScalarAndAliasEffectsAdvanceWithoutHeadChangeAndNetNoopsDoNot() {
        try (Fixture f = new Fixture()) {
            f.qualify(); String first = f.proof().token();
            f.nativeWrite(d -> { d.delete(CURRENT, SOURCE, NUMBER, integer("0")); d.add(CURRENT, SOURCE, NUMBER, integer("0")); });
            assertEquals(first, f.proof().token());
            f.nativeWrite(d -> { d.add(CURRENT, SOURCE, NUMBER, integer("0")); });
            assertEquals(first, f.proof().token());
            for (Node value : List.of(integer("1"), NodeFactory.createLiteralDT("1.5", XSDDatatype.XSDdecimal),
                NodeFactory.createLiteralDT("1/2", org.apache.jena.datatypes.TypeMapper.getInstance()
                    .getSafeTypeByName("http://www.w3.org/2002/07/owl#rational")), text("special"))) {
                String before = f.proof().token();
                f.nativeWrite(d -> replace(d, CURRENT, SOURCE, NUMBER, value));
                assertNotEquals(before, f.proof().token()); assertEquals(HEAD, f.proof().revision());
            }
            String beforeAlias = f.proof().token();
            f.nativeWrite(d -> d.add(CURRENT, SOURCE, ALIAS, text("alternate")));
            assertNotEquals(beforeAlias, f.proof().token()); f.originals();
        }
    }
    @Test public void replacementRetainsTheOriginalAnchorAndUnselectedAnchorEffectsAreLocal() {
        try (Fixture f = new Fixture()) {
            f.qualify(); var before = f.proof(); Node replacement = id(9);
            f.nativeWrite(d -> {
                f.resource(d, SOURCE, replacement);
                d.delete(CURRENT, SOURCE, p("semanticHead"), HEAD);
            });
            var after = f.proof(); assertEquals(replacement, after.revision()); assertNotEquals(before.token(), after.token());
            String token = after.token();
            f.nativeWrite(d -> replace(d, REVISIONS, HEAD, p("lifecycle"), p("Retired")));
            assertEquals(token, f.proof().token()); f.originals();
        }
    }
    @Test public void retirementProtectionTypeAndErasureCannotCertifyAbsence() {
        List<Consumer<DatasetGraph>> mutations = List.of(
            d -> replace(d, REVISIONS, HEAD, p("lifecycle"), p("Retired")),
            d -> d.add(CURRENT, SOURCE, p("protectionHead"), id(10)),
            d -> d.delete(CURRENT, SOURCE, RDF.type.asNode(), RESOURCE),
            d -> d.add(REVISIONS, HEAD, RDF.type.asNode(), p("ErasedRevision")),
            d -> d.deleteAny(CURRENT, SOURCE, Node.ANY, Node.ANY));
        for (var mutation : mutations) try (Fixture f = new Fixture()) {
            f.qualify(); var before = f.proof();
            try (CommandWork measured = new CommandWork()) {
                f.nativeWrite(mutation); assertEquals(1, count(measured, "semantic_source_resources_changed"));
            }
            unavailable(f::proof); f.originals();
            assertEquals(HEAD, before.revision());
        }
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            f.nativeWrite(d -> d.delete(CURRENT, SOURCE, RDF.type.asNode(), uri("https://schema.org/Episode")));
            assertNotEquals(before, f.proof().token());
        }
    }
    @Test public void malformedAndAmbiguousAnchorsNeverBecomeKnownAbsence() {
        List<Consumer<DatasetGraph>> corruptions = List.of(
            d -> d.deleteAny(CURRENT, SOURCE, p("semanticHead"), Node.ANY),
            d -> d.add(CURRENT, SOURCE, p("semanticHead"), OTHER_HEAD),
            d -> replace(d, REVISIONS, HEAD, p("component"), OTHER),
            d -> d.add(REVISIONS, HEAD, p("component"), OTHER),
            d -> replace(d, REVISIONS, HEAD, p("manifest"), uri("urn:bad:manifest")),
            d -> d.add(REVISIONS, HEAD, p("manifest"), uri("urn:rezics:sha256:" + "b".repeat(64))),
            d -> d.delete(REVISIONS, HEAD, RDF.type.asNode(), p("SemanticRevision")),
            d -> d.deleteAny(REVISIONS, HEAD, p("operation"), Node.ANY),
            d -> replace(d, REVISIONS, HEAD, p("modelRevision"), uri("urn:bad:profile")),
            d -> replace(d, REVISIONS, HEAD, p("sequence"), text("0")),
            d -> replace(d, REVISIONS, HEAD, p("sequence"), text("1")),
            d -> replace(d, REVISIONS, HEAD, p("sequence"), NodeFactory.createLiteralLang("1", "en")),
            d -> replace(d, REVISIONS, HEAD, p("dataEpoch"), integer("1")),
            d -> d.add(REVISIONS, HEAD, RDF.type.asNode(), p("DefinitionRevision")));
        for (var corruption : corruptions) try (Fixture f = new Fixture()) {
            f.raw(corruption); f.qualify(); unavailable(f::proof);
        }
    }
    @Test public void ownerReassignmentInvalidatesBothOldAndNewResourceGenerations() {
        try (Fixture f = new Fixture()) {
            f.qualify();
            var before = f.proof(); var other = f.proof(f.data, OTHER, NUMBER);
            try (CommandWork measured = new CommandWork()) {
                f.nativeWrite(d -> {
                    replace(d, REVISIONS, HEAD, p("component"), OTHER);
                    replace(d, CURRENT, OTHER, p("semanticHead"), HEAD);
                });
                assertEquals(2, count(measured, "semantic_source_resources_changed"));
            }
            unavailable(f::proof);
            assertNotEquals(other.token(), f.proof(f.data, OTHER, NUMBER).token());
            assertEquals(HEAD, before.revision());
        }
    }
    @Test public void unrelatedResourcesDerivedCopiesAndReceiptReplayDoNotChangeToken() {
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            f.nativeWrite(d -> {
                d.add(CURRENT, OTHER, NUMBER, integer("7"));
                d.add(uri(CommandPolicy.PUBLIC_SEARCH), uri("urn:rezics:search:name:copy"), NUMBER, integer("19"));
                d.add(uri(CommandPolicy.RECEIPTS), uri("urn:receipt:other"), p("requestDigest"), text("x"));
            });
            assertEquals(before, f.proof().token());
            Node receipt = uri("urn:receipt:semantic-source-test");
            Consumer<DatasetGraph> command = d -> {
                if (!d.contains(uri(CommandPolicy.RECEIPTS), receipt, p("requestDigest"), Node.ANY)) {
                    replace(d, CURRENT, SOURCE, NUMBER, integer("9"));
                    d.add(uri(CommandPolicy.RECEIPTS), receipt, p("requestDigest"), text("same admitted intent"));
                }
            };
            f.nativeWrite(command); String committed = f.proof().token();
            try (CommandWork measured = new CommandWork()) {
                f.nativeWrite(command); assertEquals(0, count(measured, "semantic_source_resources_changed"));
            }
            assertEquals(committed, f.proof().token());
        }
    }
    @Test public void proofAndActualEffectCostsStayBoundedAcrossUnrelatedPopulations() {
        List<List<Long>> results = new ArrayList<>();
        for (int population : List.of(0, 320, 4096)) try (Fixture f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < population; i++) f.resource(d, id(1000 + i * 2), id(1001 + i * 2)); });
            f.qualify();
            long[] physical = physical(f.data); var measured = new Measured(f.data);
            var proof = f.proof(measured, SOURCE, NUMBER); assertTrue(proof.projectionHasScalar());
            assertTrue("actual TDB iterator instrumentation must run", physical[0] > 0 && physical[1] > 0);
            List<Long> costs = new ArrayList<>(List.of(measured.probes, measured.rows, physical[0], physical[1]));
            physical[0] = physical[1] = measured.probes = measured.rows = 0;
            assertFalse(f.proof(measured, OTHER, NUMBER).projectionHasScalar());
            costs.addAll(List.of(measured.probes, measured.rows, physical[0], physical[1]));
            physical[0] = physical[1] = measured.probes = measured.rows = 0;
            f.write(() -> {
                var capture = new SearchDeltaJournal.Capture(measured);
                replace(capture.observed(), CURRENT, SOURCE, NUMBER, integer("1"));
                capture.finishSemanticSources(Long.MAX_VALUE);
                return null;
            });
            costs.addAll(List.of(measured.probes, measured.rows, physical[0], physical[1])); results.add(costs);
            System.out.println("Semantic source population=" + population + " present/absent/effect probes,rows,ranges,tuples=" + costs);
        }
        assertEquals(results.get(0), results.get(1)); assertEquals(results.get(0), results.get(2));
    }
    @Test public void pointLookupStopsAtSecondValueAndBoundsBytesBeforeHashing() {
        try (Fixture f = new Fixture()) {
            f.raw(d -> { for (int i = 1; i < 1000; i++) d.add(CURRENT, SOURCE, NUMBER, integer(Integer.toString(i))); });
            f.qualify(); var measured = new Measured(f.data);
            try (CommandWork work = new CommandWork()) {
                unavailable(() -> f.proof(measured, SOURCE, NUMBER));
                // No population or full-value iterator; the last probe consumes exactly two values.
                assertTrue(measured.rows < 40); assertEquals(measured.rows, count(work, "semantic_source_point_rows"));
            }
            System.out.println("Semantic source ambiguous=1000 bounded rows=" + measured.rows);
        }
        try (Fixture f = new Fixture()) {
            f.raw(d -> replace(d, CURRENT, SOURCE, NUMBER, text("中".repeat(10_923)))); f.qualify(); unavailable(f::proof);
        }
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            unavailable(() -> f.nativeWrite(d -> replace(d, CURRENT, SOURCE, NUMBER, text("x".repeat(SemanticSourceBasis.MAX_TERM_BYTES + 1)))));
            assertEquals(before, f.proof().token());
            unavailable(() -> f.nativeWrite(d -> {
                for (int i = 0; i < 133; i++) d.add(CURRENT, SOURCE, uri("https://schema.org/bounded-" + i), text("x".repeat(32_000)));
            }));
            assertEquals(before, f.proof().token());
        }
    }
    @Test public void rollbackExpiredAndInterruptedWorkNeverPersistGenerationOrCheckpoint() {
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            unavailable(() -> f.write(() -> {
                var capture = new SearchDeltaJournal.Capture(f.data);
                replace(capture.observed(), CURRENT, SOURCE, NUMBER, integer("1"));
                capture.finishSemanticSources(Long.MAX_VALUE);
                throw new IllegalStateException("transaction rolled back after effects");
            }));
            assertEquals(before, f.proof().token());
            unavailable(() -> f.write(() -> {
                var capture = new SearchDeltaJournal.Capture(f.data);
                capture.sourceDeadline(System.nanoTime() - 1); fail("expired work must stop before mutation"); return null;
            }));
            assertEquals(before, f.proof().token());
            unavailable(() -> f.write(() -> {
                var capture = new SearchDeltaJournal.Capture(f.data);
                replace(capture.observed(), CURRENT, SOURCE, NUMBER, integer("1"));
                capture.finishSemanticSources(System.nanoTime() - 1); return null;
            }));
            assertEquals(before, f.proof().token());
            try {
                unavailable(() -> f.write(() -> {
                    var capture = new SearchDeltaJournal.Capture(f.data);
                    replace(capture.observed(), CURRENT, SOURCE, NUMBER, integer("1"));
                    capture.finishSemanticSources(Long.MAX_VALUE);
                    Thread.currentThread().interrupt(); SemanticSourceBasis.check(Long.MAX_VALUE); return null;
                }));
                assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.proof().token()); f.originals();
        }
    }
    @Test public void interruptionThroughEffectsAbortsRatherThanTruncating() {
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            try {
                unavailable(() -> f.write(() -> {
                    Measured measured = new Measured(f.data) {
                        @Override public boolean contains(Node g, Node s, Node predicate, Node o) {
                            if (NUMBER.equals(predicate) && integer("2").equals(o)) {
                                Thread.currentThread().interrupt(); SemanticSourceBasis.check(Long.MAX_VALUE);
                            }
                            return super.contains(g, s, predicate, o);
                        }
                    };
                    var capture = new SearchDeltaJournal.Capture(measured);
                    for (int i = 1; i <= 8; i++) capture.observed().add(CURRENT, SOURCE, NUMBER, integer(Integer.toString(i)));
                    capture.finishSemanticSources(Long.MAX_VALUE); return null;
                }));
                assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.proof().token());
        }
    }
    @Test public void actualOwnerOverflowAbortsWithoutPartialGenerations() {
        try (Fixture f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i <= SemanticSourceBasis.MAX_RESOURCES; i++) f.resource(d, id(1000 + i * 2), id(1001 + i * 2)); });
            f.qualify(); String before = f.proof().token();
            try {
                f.nativeWrite(d -> { for (int i = 0; i <= SemanticSourceBasis.MAX_RESOURCES; i++) d.add(CURRENT, id(1000 + i * 2), NUMBER, integer("1")); });
                fail("65 source owners must abort");
            } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("64 Resources")); }
            assertEquals(before, f.proof().token());
            assertFalse(f.read(() -> f.data.contains(CURRENT, id(1000), NUMBER, Node.ANY)));
        }
        try (Fixture f = new Fixture()) {
            f.qualify(); String before = f.proof().token();
            try {
                f.nativeWrite(d -> {
                    for (int i = 0; i <= SemanticSourceBasis.MAX_QUADS; i++)
                        d.add(CURRENT, SOURCE, uri("https://schema.org/scalar-" + i), integer("1"));
                });
                fail("the first quad beyond the bounded capture must abort");
            } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("native quad bound")); }
            assertEquals(before, f.proof().token());
            assertFalse(f.read(() -> f.data.contains(CURRENT, SOURCE, uri("https://schema.org/scalar-0"), Node.ANY)));
            System.out.println("Semantic source overflow owners=65 quads=16385 rolled back");
        }
    }
    @Test public void rawCommitEpochRoutingRestoreAndRestartRefuseOldQualification() {
        List<Consumer<DatasetGraph>> raw = List.of(
            d -> d.add(CURRENT, OTHER, NUMBER, integer("99")),
            d -> replace(d, CONTROL, PRODUCT, p("dataEpoch"), text("44444444-4444-4444-8444-444444444444")),
            d -> replace(d, CONTROL, PRODUCT, p("routingEpoch"), text("44444444-4444-4444-8444-444444444444")),
            d -> d.add(CONTROL, PRODUCT, p("restoreHold"), NodeFactory.createLiteralByValue(true, XSDDatatype.XSDboolean)));
        for (var change : raw) try (Fixture f = new Fixture()) {
            f.qualify(); f.proof(); f.rawMaintenance(change); unavailable(f::proof);
            // A later observed write cannot conceal raw uncertainty.
            f.nativeWrite(d -> d.add(uri(CommandPolicy.RECEIPTS), uri("urn:later:receipt"), p("requestDigest"), text("later")));
            unavailable(f::proof);
        }
        for (String field : List.of("dataEpoch", "routingEpoch", "restoreHold")) try (Fixture f = new Fixture()) {
            f.qualify(); f.proof();
            Node original = f.read(() -> {
                var rows = f.data.find(CONTROL, PRODUCT, p(field), Node.ANY);
                try { return rows.hasNext() ? rows.next().getObject() : null; } finally { Iter.close(rows); }
            });
            Node changed = field.equals("restoreHold") ? NodeFactory.createLiteralByValue(true, XSDDatatype.XSDboolean)
                : text("44444444-4444-4444-8444-444444444444");
            f.nativeWrite(d -> replace(d, CONTROL, PRODUCT, p(field), changed));
            unavailable(f::proof);
            f.nativeWrite(d -> replace(d, CONTROL, PRODUCT, p(field), original));
            unavailable(f::proof);
        }
        try (Fixture f = new Fixture()) {
            f.qualify(); String token = f.proof().token();
            try {
                f.rawMaintenance(d -> { replace(d, CURRENT, SOURCE, NUMBER, integer("41")); throw new IllegalArgumentException("rollback"); });
                fail("raw failure must roll back");
            } catch (IllegalArgumentException expected) { assertEquals("rollback", expected.getMessage()); }
            assertEquals(token, f.proof().token());
            try {
                f.write(() -> {
                    var request = org.apache.jena.update.UpdateFactory.create("INSERT DATA { GRAPH <" + CommandPolicy.CURRENT + "> { <"
                        + SOURCE.getURI() + "> <" + NUMBER.getURI() + "> 41 } }; # trailing comment\n");
                    TemplateIndexService.appendRawInvalidations(request);
                    org.apache.jena.update.UpdateAction.parseExecute(request.toString(), f.data);
                    unavailable(() -> SemanticSourceBasis.proof(f.data, SOURCE, NUMBER, Long.MAX_VALUE));
                    throw new IllegalArgumentException("rollback after invalidation");
                });
                fail("raw invalidation must roll back with its write");
            } catch (IllegalArgumentException expected) { assertEquals("rollback after invalidation", expected.getMessage()); }
            assertEquals(token, f.proof().token());
            // The existing raw updater appends this deletion after user input,
            // so even an imported/forged qualification cannot survive commit.
            Node checkpoint = uri("urn:rezics:projection:semantic-source-basis");
            f.rawMaintenance(d -> replace(d, PublicNameProjection.REPAIR, checkpoint, p("semanticSourceQualification"), uri("urn:forged")));
            unavailable(f::proof);
        }
        try (Fixture f = new Fixture()) {
            f.qualify(); var old = f.proof(); f.reopen(); unavailable(f::proof);
            f.qualify(); var reopened = f.proof(); assertNotEquals(old.store(), reopened.store()); assertNotEquals(old.token(), reopened.token());
            assertEquals(old.manifest(), reopened.manifest()); f.originals();
        }
        try (Fixture original = new Fixture(); Fixture copied = new Fixture()) {
            original.qualify();
            Set<Quad> snapshot = original.read(() -> {
                var values = original.data.find(); try { return Set.copyOf(Iter.toList(values)); } finally { Iter.close(values); }
            });
            copied.raw(d -> { d.clear(); snapshot.forEach(d::add); });
            unavailable(copied::proof); copied.qualify();
            assertNotEquals(original.proof().store(), copied.proof().store());
        }
    }
    @Test public void ordinaryCommitsNeverWriteSingletonSourceCheckpoint() {
        try (Fixture f = new Fixture()) {
            f.qualify(); String source = f.proof().token();
            Node checkpoint = uri("urn:rezics:projection:semantic-source-basis");
            List<Quad> mutations = new ArrayList<>();
            // Observe physical mutations, including delete/re-add of an equal
            // value which a before/after snapshot alone would miss.
            DatasetGraph recording = new DatasetGraphWrapper(f.data) {
                @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
                    if (PublicNameProjection.REPAIR.equals(g) && checkpoint.equals(s))
                        throw new AssertionError("ordinary effects must not check a singleton commit stamp");
                    return super.find(g, s, p, o);
                }
                @Override public void add(Quad quad) { mutations.add(quad); super.add(quad); }
                @Override public void delete(Quad quad) { mutations.add(quad); super.delete(quad); }
                @Override public void add(Node g, Node s, Node p, Node o) { add(new Quad(g, s, p, o)); }
                @Override public void delete(Node g, Node s, Node p, Node o) { delete(new Quad(g, s, p, o)); }
            };
            for (Consumer<DatasetGraph> edit : List.<Consumer<DatasetGraph>>of(
                d -> {},
                d -> d.add(uri(CommandPolicy.RECEIPTS), uri("urn:ordinary:receipt"), p("requestDigest"), text("same")),
                d -> d.add(uri(CommandPolicy.PUBLIC_SEARCH), uri("urn:ordinary:copy"), NUMBER, integer("2")),
                d -> d.add(CURRENT, OTHER, NUMBER, integer("7")),
                d -> d.add(CURRENT, OTHER, NUMBER, integer("7")),
                d -> replace(d, CURRENT, SOURCE, NUMBER, integer("8")))) {
                f.write(() -> {
                    var capture = new SearchDeltaJournal.Capture(recording);
                    edit.accept(capture.observed()); capture.finishSemanticSources(Long.MAX_VALUE); return null;
                });
                assertFalse("ordinary commits must never mutate the singleton checkpoint", mutations.stream().anyMatch(q -> checkpoint.equals(q.getSubject())));
            }
            assertTrue("instrumentation must observe Resource-local effect writes", mutations.stream().anyMatch(q -> SOURCE.equals(q.getSubject()) && p("semanticSourceEffect").equals(q.getPredicate())));
            assertNotEquals(source, f.proof().token());
            assertFalse(f.read(() -> f.data.contains(PublicNameProjection.REPAIR, checkpoint, p("semanticSourceVersion"), Node.ANY)));
            System.out.println("Semantic source ordinary singleton writes=0; raw/restore uncertainty stays closed");
        }
    }
    /** Separate catalogue preparation fixtures; the source fixtures above remain unchanged. */
    private static final class CatalogueFixture implements AutoCloseable {
        final Fixture owner = new Fixture();
        final java.util.Map<String, byte[]> originals = new java.util.LinkedHashMap<>();
        final Node structure = id(20_000), generation = id(20_001), operation = id(20_002);
        final Node profile = uri("https://rezics.com/definition/structure-composition-v1");
        final Node checkpoint = uri("urn:rezics:projection:retained-anchor-catalogue");
        final Node checkpointField = p("retainedCatalogueCheckpoint");
        final Node manifest;
        CatalogueFixture() {
            String removed = "{\"occurrence\":\"" + id(20_010).getURI()
                + "\",\"state\":\"removed\",\"parent\":\"" + structure.getURI()
                + "\",\"role\":\"chapter\",\"target\":\"" + id(20_020).getURI()
                + "\",\"selection\":{\"mode\":\"follow-context\"},\"labels\":[],\"introducedBy\":\""
                + operation.getURI() + "\",\"removedBy\":\"" + operation.getURI() + "\"}";
            String recordPage = object("{\"format\":\"rezics-structure-page-v1\",\"tree\":\"record\","
                + "\"level\":0,\"entries\":[" + removed + ","
                + removed.replace(id(20_010).getURI(), id(20_011).getURI()) + "]}");
            String orderPage = object("{\"format\":\"rezics-structure-page-v1\",\"tree\":\"order\","
                + "\"level\":0,\"entries\":[]}");
            String root = object("{\"format\":\"rezics-structure-manifest-v1\",\"structure\":\""
                + structure.getURI() + "\",\"structureOf\":\"" + id(20_030).getURI()
                + "\",\"profile\":\"book-composition\",\"generation\":\"" + generation.getURI()
                + "\",\"pageFormat\":\"rezics-structure-page-v1\",\"records\":{\"page\":\"sha256:"
                + recordPage + "\",\"level\":0,\"count\":2},\"order\":{\"page\":\"sha256:"
                + orderPage + "\",\"level\":0,\"count\":0},\"placementCount\":0,\"measures\":[],"
                + "\"model\":\"" + profile.getURI() + "\",\"shape\":\"" + profile.getURI() + "\"}");
            manifest = uri("urn:rezics:sha256:" + root);
            raw(d -> {
                d.add(CONTROL, PRODUCT, p("restoreHold"), NodeFactory.createLiteralByValue(true, XSDDatatype.XSDboolean));
                d.add(CONTROL, PRODUCT, p("restoreCutover"), uri("urn:rezics:restore:catalogue-fixture"));
            });
        }
        DatasetGraph data() { return owner.data; }
        String object(String json) {
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8); String digest = sha(bytes);
            try { Files.write(owner.directory.resolve(digest), bytes); }
            catch (Exception failure) { throw new AssertionError(failure); }
            originals.put(digest, bytes); return digest;
        }
        void raw(Consumer<DatasetGraph> edit) { owner.raw(edit); }
        void revision(DatasetGraph data, Node graph, Node anchor) {
            data.add(graph, anchor, RDF.type.asNode(), p("StructureRevision"));
            data.add(graph, anchor, RDF.type.asNode(), p("RevisionAnchor"));
            data.add(graph, anchor, p("component"), structure);
            data.add(graph, anchor, p("manifest"), manifest);
            data.add(graph, anchor, p("generation"), generation);
            data.add(graph, anchor, p("operation"), operation);
            data.add(graph, anchor, p("structureOperation"), p("Edit"));
            data.add(graph, anchor, p("placementCount"), integer("0"));
            data.add(graph, anchor, p("modelRevision"), profile);
            data.add(graph, anchor, p("shapeRevision"), profile);
            data.add(graph, anchor, p("datasetId"), PRODUCT);
            data.add(graph, anchor, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
            data.add(graph, anchor, p("sequence"), integer("1"));
        }
        void revisionGeneration(DatasetGraph data, Node graph, Node anchor, Node nextGeneration) {
            byte[] root = originals.get(manifest.getURI().substring("urn:rezics:sha256:".length()));
            String digest = object(new String(root, StandardCharsets.UTF_8).replace(generation.getURI(), nextGeneration.getURI()));
            replace(data, graph, anchor, p("generation"), nextGeneration);
            replace(data, graph, anchor, p("manifest"), uri("urn:rezics:sha256:" + digest));
        }
        void seal(DatasetGraph data, Node graph, Node anchor, Node revision) {
            String pins = object("{\"format\":\"rezics-structure-page-v1\",\"tree\":\"pin\","
                + "\"level\":0,\"entries\":[]}");
            String sealed = object("{\"format\":\"rezics-structure-seal-v1\",\"structure\":\""
                + structure.getURI() + "\",\"structureRevision\":\"" + revision.getURI()
                + "\",\"structureManifest\":\"sha256:" + manifest.getURI().substring("urn:rezics:sha256:".length())
                + "\",\"pins\":{\"page\":\"sha256:" + pins + "\",\"level\":0,\"count\":0},"
                + "\"coverage\":\"complete\",\"unavailableCount\":0,\"model\":\"" + profile.getURI() + "\"}");
            data.add(graph, anchor, RDF.type.asNode(), p("StructureSeal"));
            data.add(graph, anchor, p("structure"), structure);
            data.add(graph, anchor, p("structureRevision"), revision);
            data.add(graph, anchor, p("manifest"), uri("urn:rezics:sha256:" + sealed));
            data.add(graph, anchor, p("sealedBy"), operation);
            data.add(graph, anchor, p("sealCoverage"), p("Complete"));
            data.add(graph, anchor, p("unavailableCount"), integer("0"));
            data.add(graph, anchor, p("modelRevision"), profile);
            data.add(graph, anchor, p("shapeRevision"), profile);
            data.add(graph, anchor, p("datasetId"), PRODUCT);
            data.add(graph, anchor, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
            data.add(graph, anchor, p("sequence"), integer("1"));
        }
        SemanticSourceBasis.Catalogue.Ticket begin() { return SemanticSourceBasis.Catalogue.begin(data(), Long.MAX_VALUE); }
        SemanticSourceBasis.Catalogue.Page turn(SemanticSourceBasis.Catalogue.Ticket ticket) {
            return SemanticSourceBasis.Catalogue.turn(data(), ticket, Long.MAX_VALUE);
        }
        Node savedCheckpoint() {
            return owner.read(() -> {
                var rows = data().find(PublicNameProjection.REPAIR, checkpoint, checkpointField, Node.ANY);
                try { return rows.hasNext() ? rows.next().getObject() : null; } finally { Iter.close(rows); }
            });
        }
        long version() { return owner.read(() -> TDBInternal.requireStorage(data()).getTxnSystem().getThreadTransaction().getDataVersion()); }
        @Override public void close() {
            try {
                owner.originals();
                for (var entry : originals.entrySet()) assertArrayEquals(entry.getValue(), Files.readAllBytes(owner.directory.resolve(entry.getKey())));
            } catch (Exception failure) { throw new AssertionError(failure); }
            finally { owner.close(); }
        }
    }
    private static void catalogueRejected(Runnable operation) {
        try { operation.run(); fail("unqualified catalogue work must be refused"); }
        catch (RuntimeException expected) { assertNotNull(expected.getMessage()); }
    }
    /** Count quad/triple B-tree iterators and successful direct record lookups. */
    private static long[] cataloguePhysical(DatasetGraph data) {
        var storage = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data));
        long[] counts = {0, 0};
        var tables = List.of(storage.getQuadTable().getNodeTupleTable().getTupleTable(),
            storage.getTripleTable().getNodeTupleTable().getTupleTable());
        for (int dimension = 4; dimension >= 3; dimension--) {
            var table = tables.get(4 - dimension);
            for (int i = 0; i < table.numIndexes(); i++) {
                var original = table.getIndex(i);
                var record = (TupleIndexRecord) original.baseTupleIndex();
                var range = (org.apache.jena.dboe.index.RangeIndex) Proxy.newProxyInstance(
                    org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(), new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
                    (proxy, method, args) -> {
                        Object result = method.invoke(record.getRangeIndex(), args);
                        if (method.getName().equals("iterator")) {
                            counts[0]++;
                            return Iter.map((Iterator<?>) result, value -> { counts[1]++; return value; });
                        }
                        if (method.getName().equals("find") && result != null
                            || method.getName().equals("contains") && Boolean.TRUE.equals(result)) counts[1]++;
                        return result;
                    });
                table.setTupleIndex(i, new TupleIndexRecord(dimension, original.getMapping(), original.getName(),
                    range.getRecordFactory(), range));
            }
        }
        return counts;
    }
    private static List<SemanticSourceBasis.Catalogue.Reference> catalogueDrain(CatalogueFixture f, long[] physical) {
        var ticket = f.begin(); var references = new ArrayList<SemanticSourceBasis.Catalogue.Reference>();
        for (int turns = 0; turns < 1000; turns++) {
            physical[0] = physical[1] = 0;
            var page = f.turn(ticket);
            assertTrue("all actual prefix, point and checkpoint tuples must fit one turn", physical[1] <= 64);
            assertTrue(page.namedTuples() + page.defaultTuples() <= 64);
            assertTrue(page.references().size() <= 1);
            assertTrue(page.probes() >= 0); assertTrue(page.rows() >= 0);
            assertTrue(page.bytes() >= 0 && page.bytes() <= SemanticSourceBasis.MAX_PROOF_BYTES);
            references.addAll(page.references()); ticket = page.next();
            if (page.catalogueEof()) {
                physical[0] = physical[1] = 0; long before = f.version();
                assertEquals(page, f.turn(ticket));
                assertEquals("EOF replay must abort without an empty WRITE commit", before, f.version());
                assertTrue(physical[1] <= 64); return references;
            }
        }
        throw new AssertionError("bounded catalogue did not reach actual EOF");
    }
    @Test public void retainedCatalogueKeepsHistoricalStagedCancelledDeadDuplicateAndDefaultCustody() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            Node current = id(21_000), historical = id(21_001), staged = id(21_002), cancelled = id(21_003);
            f.raw(d -> {
                for (Node anchor : List.of(current, historical, staged, cancelled)) f.revision(d, REVISIONS, anchor);
                d.add(REVISIONS, current, p("predecessor"), historical);
                d.add(CURRENT, f.structure, RDF.type.asNode(), p("Structure"));
                d.add(CURRENT, f.structure, p("structureHead"), current);
                d.add(CURRENT, f.structure, p("selectedGeneration"), f.generation);
                d.add(CURRENT, f.structure, p("structureOf"), id(20_030));
                d.add(CURRENT, f.structure, p("structureProfile"), p("BookComposition"));
                d.add(CURRENT, f.generation, p("structure"), f.structure);
                d.add(CURRENT, f.generation, p("placementCount"), integer("0"));
                d.add(CURRENT, f.generation, p("generationState"), p("Active"));
                f.revisionGeneration(d, REVISIONS, staged, id(21_020));
                f.revisionGeneration(d, REVISIONS, cancelled, id(21_021));
                d.add(CURRENT, id(21_020), p("generationState"), p("Staging"));
                d.add(CURRENT, id(21_021), p("generationState"), p("Cancelled"));
                f.revision(d, Quad.defaultGraphNodeGenerated, historical);
                f.seal(d, REVISIONS, id(21_010), current);
                f.seal(d, Quad.defaultGraphNodeGenerated, id(21_011), historical);
            });
            var references = catalogueDrain(f, cataloguePhysical(f.data()));
            assertEquals(7, references.size());
            assertEquals(5, references.stream().filter(r -> REVISIONS.equals(r.graph())).count());
            assertEquals(2, references.stream().filter(r -> Quad.isDefaultGraph(r.graph())).count());
            assertEquals(2, references.stream().filter(r -> historical.equals(r.anchor())).count());
            assertEquals(2, references.stream().filter(r -> p("StructureSeal").equals(r.kind())).count());
            assertTrue(references.stream().allMatch(r -> f.structure.equals(r.structure())));
            assertEquals(3, references.stream().filter(r -> p("StructureRevision").equals(r.kind()) && f.manifest.equals(r.manifest())).count());
            assertTrue(references.stream().filter(r -> staged.equals(r.anchor())).allMatch(r -> id(21_020).equals(r.generation())));
            assertTrue(references.stream().filter(r -> cancelled.equals(r.anchor())).allMatch(r -> id(21_021).equals(r.generation())));
            assertTrue(f.originals.size() >= 5);
            catalogueRejected(f.owner::proof);
        }
    }
    @Test public void retainedCatalogueProvesEmptyButRefusesMalformedOrSplitCustody() {
        try (CatalogueFixture f = new CatalogueFixture()) { assertTrue(catalogueDrain(f, cataloguePhysical(f.data())).isEmpty()); }
        List<Consumer<CatalogueFixture>> corruptions = List.of(
            f -> f.raw(d -> d.deleteAny(REVISIONS, id(22_000), p("manifest"), Node.ANY)),
            f -> f.raw(d -> d.add(REVISIONS, id(22_000), p("manifest"), uri("urn:rezics:sha256:" + "b".repeat(64)))),
            f -> f.raw(d -> replace(d, REVISIONS, id(22_000), p("placementCount"), integer("-1"))),
            f -> f.raw(d -> replace(d, REVISIONS, id(22_000), p("sequence"), text("1"))),
            f -> f.raw(d -> replace(d, REVISIONS, id(22_000), p("modelRevision"), uri("urn:wrong-profile"))),
            f -> f.raw(d -> d.delete(REVISIONS, id(22_000), RDF.type.asNode(), p("RevisionAnchor"))),
            f -> f.raw(d -> {
                d.deleteAny(REVISIONS, id(22_000), p("manifest"), Node.ANY);
                d.add(Quad.defaultGraphNodeGenerated, id(22_000), p("manifest"), f.manifest);
            }));
        for (var corruption : corruptions) try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> f.revision(d, REVISIONS, id(22_000))); corruption.accept(f);
            var ticket = f.begin(); catalogueRejected(() -> f.turn(ticket));
            assertFalse(f.data().isInTransaction());
        }
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> { f.revision(d, Quad.defaultGraphNodeGenerated, id(22_000)); f.seal(d, REVISIONS, id(22_010), id(22_000)); });
            var ticket = f.begin(); catalogueRejected(() -> f.turn(ticket));
        }
    }
    @Test public void retainedCatalogueTraverses129ReferencesWithOneSharedPhysicalBudget() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> {
                for (int i = 0; i < 97; i++) f.revision(d, REVISIONS, id(23_000 + i));
                for (int i = 0; i < 32; i++) f.revision(d, Quad.defaultGraphNodeGenerated, id(24_000 + i));
                for (int i = 0; i < 320; i++) d.add(CURRENT, id(25_000 + i), p("unrelated"), text("ignored"));
            });
            var references = catalogueDrain(f, cataloguePhysical(f.data()));
            assertEquals(129, references.size());
            assertEquals(129, references.stream().map(r -> r.graph().toString() + "\0" + r.anchor()).distinct().count());
            assertEquals(32, references.stream().filter(r -> Quad.isDefaultGraph(r.graph())).count());
        }
    }
    @Test public void retainedCatalogueOpaqueTicketsReplayWithoutAdvancingAndRejectSkippedAttempts() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> { for (int i = 0; i < 3; i++) f.revision(d, REVISIONS, id(26_000 + i)); });
            var ticket = f.begin(); var first = f.turn(ticket); long before = f.version();
            assertEquals(first, f.turn(ticket)); assertEquals(before, f.version());
            catalogueRejected(() -> f.turn(new SemanticSourceBasis.Catalogue.Ticket(ticket.attempt(), java.util.UUID.randomUUID().toString())));
            catalogueRejected(() -> f.turn(new SemanticSourceBasis.Catalogue.Ticket(java.util.UUID.randomUUID().toString(), first.next().cursor())));
            var second = f.turn(first.next()); assertFalse(second.catalogueEof());
            catalogueRejected(() -> f.turn(ticket));
            var replacement = f.begin(); catalogueRejected(() -> f.turn(second.next()));
            assertFalse(f.turn(replacement).references().isEmpty());
        }
    }
    @Test public void retainedCatalogueLateInsertionAndEmptyForeignCommitInvalidatePartialAndEof() {
        for (boolean eof : List.of(false, true)) for (boolean insert : List.of(false, true)) try (CatalogueFixture f = new CatalogueFixture()) {
            Node late = id(27_000);
            f.raw(d -> {
                d.add(CURRENT, late, p("allocatedBeforeCursor"), text("physical address precedes anchors"));
                if (!eof) for (int i = 0; i < 2; i++) f.revision(d, REVISIONS, id(27_010 + i));
            });
            var page = f.turn(f.begin()); assertEquals(eof, page.catalogueEof());
            f.raw(d -> { if (insert) f.revision(d, REVISIONS, late); });
            catalogueRejected(() -> f.turn(page.next()));
            assertFalse(f.data().isInTransaction());
            assertEquals((eof ? 0 : 2) + (insert ? 1 : 0), catalogueDrain(f, cataloguePhysical(f.data())).size());
        }
    }
    @Test public void retainedCatalogueRollbackDeadlinesAndInterruptsLeaveRetryableCheckpoint() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> f.revision(d, REVISIONS, id(28_000)));
            var ticket = f.begin(); Node saved = f.savedCheckpoint(); long version = f.version();
            DatasetGraph failing = new DatasetGraphWrapper(f.data()) {
                @Override public void commit() { throw new IllegalStateException("catalogue commit failed before durability"); }
            };
            var halts = new ArrayList<Integer>();
            var lines = new ArrayList<String>();
            var halt = CommitHalt.halt;
            var logged = CommitHalt.logged;
            CommitHalt.halt = halts::add;
            CommitHalt.logged = lines::add;
            try {
                catalogueRejected(() -> SemanticSourceBasis.Catalogue.turn(failing, ticket, Long.MAX_VALUE));
            } finally {
                CommitHalt.halt = halt;
                CommitHalt.logged = logged;
            }
            assertEquals(List.of(CommitHalt.STATUS), halts);
            assertEquals(1, lines.size());
            assertFalse(lines.get(0).contains("\n"));
            assertTrue(lines.get(0).contains(IllegalStateException.class.getName()));
            assertTrue(lines.get(0).contains("catalogue commit failed before durability"));
            assertEquals(saved, f.savedCheckpoint()); assertEquals(version, f.version()); assertFalse(f.data().isInTransaction());
            catalogueRejected(() -> SemanticSourceBasis.Catalogue.turn(f.data(), ticket, System.nanoTime() - 1));
            assertEquals(saved, f.savedCheckpoint()); assertEquals(version, f.version());
            DatasetGraph interrupted = new DatasetGraphWrapper(f.data()) {
                @Override public Iterator<Quad> find(Node g, Node s, Node predicate, Node o) {
                    if (p("placementCount").equals(predicate)) {
                        Thread.currentThread().interrupt(); SemanticSourceBasis.check(Long.MAX_VALUE);
                    }
                    return super.find(g, s, predicate, o);
                }
            };
            try {
                catalogueRejected(() -> SemanticSourceBasis.Catalogue.turn(interrupted, ticket, Long.MAX_VALUE));
                assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertFalse(f.data().isInTransaction()); assertEquals(saved, f.savedCheckpoint()); assertEquals(version, f.version());
            assertEquals(1, f.turn(ticket).references().size());
        }
    }
    @Test public void retainedCatalogueActualRawInvalidationCannotForgeCheckpointSnapshot() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> { f.revision(d, REVISIONS, id(29_000)); f.revision(d, REVISIONS, id(29_001)); });
            var page = f.turn(f.begin()); String saved = f.savedCheckpoint().getLiteralLexicalForm();
            f.owner.write(() -> {
                long next = TDBInternal.requireStorage(f.data()).getTxnSystem().getThreadTransaction().getDataVersion() + 1;
                String forged = saved.replaceAll("(\\\"version\\\"\\s*:\\s*\\\"?)[0-9]+", "$1" + next);
                assertNotEquals("forge must target the checkpoint snapshot, not merely replay an obsolete version", saved, forged);
                replace(f.data(), PublicNameProjection.REPAIR, f.checkpoint, f.checkpointField, text(forged));
                var request = org.apache.jena.update.UpdateFactory.create("# actual raw invalidation boundary\n");
                TemplateIndexService.appendRawInvalidations(request);
                org.apache.jena.update.UpdateAction.parseExecute(request.toString(), f.data());
                return null;
            });
            catalogueRejected(() -> f.turn(page.next()));
            assertFalse(f.data().isInTransaction());
        }
    }
    @Test public void retainedCatalogueHoldEpochRoutingAndStoreAbaNeverReviveOldTicket() {
        for (String field : List.of("restoreHold", "dataEpoch", "routingEpoch", "restoreCutover")) try (CatalogueFixture f = new CatalogueFixture()) {
            var page = f.turn(f.begin());
            Node original = f.owner.read(() -> {
                var rows = f.data().find(CONTROL, PRODUCT, p(field), Node.ANY);
                try { return rows.next().getObject(); } finally { Iter.close(rows); }
            });
            Node changed = field.equals("restoreHold") ? NodeFactory.createLiteralByValue(false, XSDDatatype.XSDboolean)
                : field.equals("restoreCutover") ? uri("urn:rezics:restore:other-cutover") : text("44444444-4444-4444-8444-444444444444");
            f.raw(d -> replace(d, CONTROL, PRODUCT, p(field), changed));
            catalogueRejected(() -> f.turn(page.next()));
            if (field.equals("restoreHold")) catalogueRejected(f::begin);
            f.raw(d -> replace(d, CONTROL, PRODUCT, p(field), original));
            catalogueRejected(() -> f.turn(page.next()));
            assertTrue(f.turn(f.begin()).catalogueEof());
        }
        try (CatalogueFixture f = new CatalogueFixture()) {
            var page = f.turn(f.begin()); f.owner.reopen();
            catalogueRejected(() -> f.turn(page.next()));
            assertTrue(f.turn(f.begin()).catalogueEof());
        }
    }
    @Test public void retainedCataloguePhysicalCostsStayFixedAcrossUnrelatedNamedAndDefaultPopulations() {
        for (boolean alias : List.of(false, true)) {
            var populations = new ArrayList<List<Long>>();
            for (int population : List.of(0, 320, 4096)) try (CatalogueFixture f = new CatalogueFixture()) {
                f.raw(d -> {
                    f.revision(d, alias ? Quad.defaultGraphNodeGenerated : REVISIONS, id(30_000));
                    for (int i = 0; i < population; i++) {
                        d.add(CURRENT, id(40_000 + i), RDF.type.asNode(), RESOURCE);
                        d.add(CURRENT, id(40_000 + i), NUMBER, integer("0"));
                        d.add(Quad.defaultGraphNodeGenerated, id(50_000 + i), RDF.type.asNode(), RESOURCE);
                        d.add(Quad.defaultGraphNodeGenerated, id(50_000 + i), uri("https://schema.org/name"), text("unrelated"));
                    }
                });
                var physical = cataloguePhysical(f.data());
                var ticket = f.begin();
                var costs = new ArrayList<Long>(List.of(physical[0], physical[1]));
                assertTrue("begin must also have bounded physical work", physical[1] <= 64);
                physical[0] = physical[1] = 0;
                var page = f.turn(ticket);
                assertEquals(1, page.references().size()); assertFalse(page.catalogueEof());
                assertTrue(physical[1] <= 64);
                costs.addAll(List.of((long) page.namedTuples(), (long) page.defaultTuples(), (long) page.probes(),
                    (long) page.rows(), (long) page.bytes(), physical[0], physical[1]));
                populations.add(costs);
                System.out.println("Semantic catalogue population=" + population + " alias=" + alias
                    + " begin ranges,physicaltuples=" + costs.subList(0, 2)
                    + " named/default prefix,pointprobes,pointrows,bytes,ranges,physicaltuples=" + costs.subList(2, costs.size()));
            }
            assertEquals(populations.get(0), populations.get(1)); assertEquals(populations.get(0), populations.get(2));
        }
    }
    @Test public void retainedCatalogueBoundsTermsSealCustodyAndCancellationAfterCheckpointWrite() {
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> f.revision(d, REVISIONS, id(60_000)));
            var ticket = f.begin(); Node saved = f.savedCheckpoint(); long version = f.version();
            catalogueRejected(() -> f.turn(new SemanticSourceBasis.Catalogue.Ticket("x".repeat(SemanticSourceBasis.MAX_TERM_BYTES + 1), ticket.cursor())));
            catalogueRejected(() -> f.turn(new SemanticSourceBasis.Catalogue.Ticket(ticket.attempt(), "中".repeat(10_923))));
            assertEquals(saved, f.savedCheckpoint()); assertEquals(version, f.version());
            DatasetGraph cancelledAfterWrite = new DatasetGraphWrapper(f.data()) {
                @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                    super.add(graph, subject, predicate, object);
                    if (PublicNameProjection.REPAIR.equals(graph) && f.checkpoint.equals(subject) && f.checkpointField.equals(predicate)) {
                        Thread.currentThread().interrupt(); SemanticSourceBasis.check(Long.MAX_VALUE);
                    }
                }
            };
            try {
                catalogueRejected(() -> SemanticSourceBasis.Catalogue.turn(cancelledAfterWrite, ticket, Long.MAX_VALUE));
                assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertFalse(f.data().isInTransaction()); assertEquals(saved, f.savedCheckpoint()); assertEquals(version, f.version());
            assertEquals(1, f.turn(ticket).references().size());
        }
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> {
                f.revision(d, REVISIONS, id(60_000));
                replace(d, REVISIONS, id(60_000), p("dataEpoch"), text("中".repeat(10_923)));
            });
            var ticket = f.begin(); Node saved = f.savedCheckpoint();
            catalogueRejected(() -> f.turn(ticket)); assertEquals(saved, f.savedCheckpoint()); assertFalse(f.data().isInTransaction());
        }
        try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> {
                replace(d, CONTROL, PRODUCT, p("dataEpoch"), text("e".repeat(32_000)));
                replace(d, CONTROL, PRODUCT, p("routingEpoch"), text("r".repeat(32_000)));
                replace(d, CONTROL, PRODUCT, p("restoreCutover"), uri("urn:cut:" + "m".repeat(32_000)));
            });
            catalogueRejected(f::begin); assertNull(f.savedCheckpoint()); assertFalse(f.data().isInTransaction());
        }
        List<Consumer<CatalogueFixture>> corruptions = List.of(
            f -> f.raw(d -> replace(d, REVISIONS, id(61_001), p("sealCoverage"), p("Unknown"))),
            f -> f.raw(d -> replace(d, REVISIONS, id(61_001), p("unavailableCount"), integer("1"))),
            f -> f.raw(d -> d.deleteAny(REVISIONS, id(61_001), p("sealedBy"), Node.ANY)),
            f -> f.raw(d -> d.add(REVISIONS, id(61_001), p("structureRevision"), id(61_002))));
        for (var corruption : corruptions) try (CatalogueFixture f = new CatalogueFixture()) {
            f.raw(d -> { f.revision(d, REVISIONS, id(61_000)); f.seal(d, REVISIONS, id(61_001), id(61_000)); });
            corruption.accept(f);
            catalogueRejected(() -> catalogueDrain(f, cataloguePhysical(f.data())));
            assertFalse(f.data().isInTransaction());
        }
    }
}
