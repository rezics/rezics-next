package com.rezics.jena;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Native source/basis prerequisites only: no staged-publication or query claim. */
public class WorkNameScopeBasisTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node id(int value) {
        return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value));
    }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH),
        PRODUCT = uri("urn:rezics:dataset:product"), WORK = id(10), MAIN = id(11), OTHER = id(20), OTHER_MAIN = id(21),
        LABEL = uri("http://www.w3.org/2000/01/rdf-schema#label");
    private static final List<Node> NAMES = List.of(LABEL, uri("https://schema.org/name"),
        uri("https://schema.org/alternateName"), p("localizedName"),
        uri("http://www.w3.org/2004/02/skos/core#prefLabel"), uri("http://www.w3.org/2004/02/skos/core#altLabel"));

    private static void replace(DatasetGraph data, Node graph, Node subject, Node predicate, Node value) {
        data.deleteAny(graph, subject, predicate, Node.ANY);
        if (value != null) data.add(graph, subject, predicate, value);
    }
    private static void work(DatasetGraph data, Node work, Node main) {
        data.add(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
        data.add(CURRENT, work, p("mainVersion"), main);
        data.add(CURRENT, work, LABEL, NodeFactory.createLiteralLang("Original name", "en"));
        data.add(CURRENT, main, RDF.type.asNode(), p("MainVersion"));
        data.add(CURRENT, main, p("work"), work);
    }
    private static Node owner(DatasetGraph data, int number, Node work, Node main) {
        Node realm = id(1000 + number), slot = CanonicalPolicy.realmOwner(realm, main);
        data.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
        data.add(CURRENT, slot, p("realm"), realm);
        data.add(CURRENT, slot, p("mainVersion"), main);
        data.add(CURRENT, slot, p("work"), work);
        data.add(CURRENT, slot, p("selectionHead"), id(20000 + number));
        // Directory coverage includes extant owners even when policy denies reads.
        data.add(CURRENT, realm, p("disclosure"), p("Private"));
        data.add(CURRENT, realm, p("listing"), text("unlisted"));
        return slot;
    }
    private static void header(DatasetGraph data, Node work, Node revision, Node component, String payload) {
        data.add(CURRENT, component, RDF.type.asNode(), p("WorkMetadataComponent"));
        data.add(CURRENT, component, p("work"), work);
        data.add(CURRENT, component, p("metadataKind"), text("header"));
        data.add(CURRENT, component, p("metadataHead"), revision);
        data.add(REVISIONS, revision, RDF.type.asNode(), p("WorkMetadataRevision"));
        data.add(REVISIONS, revision, p("component"), component);
        data.add(REVISIONS, revision, p("metadataState"), text(payload));
    }
    private static String payload(String title) {
        return "{\"kind\":\"header\",\"originalTitle\":null,\"localized\":[{\"language\":\"fr\",\"title\":\""
            + title + "\",\"description\":null,\"mainVersionLabel\":null}]}";
    }
    private static long counter(CommandWork work, String name) {
        var match = java.util.regex.Pattern.compile("(?:^|,)" + name + "=([0-9]+)").matcher(work.counters());
        return match.find() ? Long.parseLong(match.group(1)) : 0;
    }

    private static final class Fixture implements AutoCloseable {
        final DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        int receipt;
        Fixture() { this(true); }
        Fixture(boolean exclusive) {
            raw(d -> {
                d.add(CONTROL, PRODUCT, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
                d.add(CONTROL, PRODUCT, p("routingEpoch"), text("22222222-2222-4222-8222-222222222222"));
                d.add(CONTROL, PRODUCT, p("textIndexGeneration"), uri("urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333"));
                d.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(java.math.BigInteger.ZERO,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                work(d, WORK, MAIN); work(d, OTHER, OTHER_MAIN);
                SearchDeltaJournal.initialize(d);
                if (exclusive) PublicNameProjection.workScopeExclusiveStartup(d);
            });
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ);
            try { return operation.get(); } finally { data.end(); }
        }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T value = operation.get(); data.commit(); return value; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; }
            finally { data.end(); }
        }
        void raw(Consumer<DatasetGraph> operation) {
            write(() -> {
                operation.accept(data);
                // The controlled maintenance route appends this same parsed
                // fence after its update, in the same TDB transaction.
                org.apache.jena.update.UpdateAction.execute(
                    org.apache.jena.update.UpdateFactory.create(PublicNameProjection.workScopeUncertaintyUpdate()),
                    org.apache.jena.query.DatasetFactory.wrap(data));
                return null;
            });
        }
        void nativeWrite(Consumer<DatasetGraph> operation) {
            write(() -> { append(data, operation); return null; });
        }
        void append(DatasetGraph source, Consumer<DatasetGraph> operation) {
            var capture = new SearchDeltaJournal.Capture(source);
            DatasetGraph observed = capture.observed();
            operation.accept(observed);
            var rows = observed.find(CONTROL, PRODUCT, p("sequence"), Node.ANY);
            Node old;
            try { old = rows.next().getObject(); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            replace(observed, CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(
                new java.math.BigInteger(old.getLiteralLexicalForm()).add(java.math.BigInteger.ONE),
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            SearchDeltaJournal.append(source, capture, ++receipt * 2L);
        }
        int prepare() {
            int total = 0;
            for (int turn = 0; turn < 100; turn++) {
                int visited = write(() -> {
                    try (var measured = new CommandWork()) {
                        int consumed = PublicNameProjection.prepareWorkScopeDirectory(data);
                        assertEquals("cold tuple work must count actual GPOS records", consumed,
                            counter(measured, "work_name_scope_cold_tuples"));
                        return consumed;
                    }
                });
                assertTrue(visited >= 0 && visited <= 64); total += visited;
                if (visited < 64) return total;
            }
            throw new AssertionError("cold directory preparation did not finish");
        }
        Node token(Node work) { return read(() -> PublicNameProjection.nameSourceToken(data, work)); }
        String basis(Node work) { return read(() -> TemplateIndexService.workAdoptionBasis(data, work)); }
        void begin(Node work, Node pass) { write(() -> { PublicNameProjection.beginWorkScope(data, work, pass); return null; }); }
        PublicNameProjection.ScopeTurn advance(Node pass) {
            Node replay = uri("urn:receipt:work-scope-test:" + ++receipt);
            return write(() -> PublicNameProjection.advanceWorkScope(data, pass, replay));
        }
        boolean complete(Node pass) { return read(() -> PublicNameProjection.workScopeComplete(data, pass)); }
        List<PublicNameProjection.ScopeOwner> drain(Node pass) {
            var owners = new ArrayList<PublicNameProjection.ScopeOwner>();
            for (int turn = 0; turn < 100; turn++) {
                var result = advance(pass); assertTrue(result.visited() <= 64); owners.addAll(result.owners());
                if (result.complete()) { assertTrue(complete(pass)); return owners; }
            }
            throw new AssertionError("finite owner pass did not finish");
        }
        @Override public void close() {
            if (data.isInTransaction()) { data.abort(); data.end(); }
            data.close();
        }
    }

    private static final class Measured extends DatasetGraphWrapper {
        long rows, probes;
        Measured(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            probes++;
            if (subject.equals(Node.ANY) && (graph.equals(CURRENT) || graph.equals(PUBLIC)))
                throw new AssertionError("ordinary scope/source operation opened a population iterator: " + predicate);
            if (graph.equals(CURRENT) && NAMES.contains(predicate) && object.equals(Node.ANY))
                throw new AssertionError("source token opened a name inventory iterator");
            return org.apache.jena.atlas.iterator.Iter.map(super.find(graph, subject, predicate, object), quad -> { rows++; return quad; });
        }
        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
            probes++; return super.contains(graph, subject, predicate, object);
        }
    }

    @Test public void coldPreparationCountsEveryOwnerAndDoesNotCertifyAPartialDirectory() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); });
            assertEquals(64, (int) f.write(() -> {
                try (var measured = new CommandWork()) {
                    int visited = PublicNameProjection.prepareWorkScopeDirectory(f.data);
                    assertEquals(64, counter(measured, "work_name_scope_cold_tuples"));
                    return visited;
                }
            }));
            assertThrows(IllegalStateException.class, () -> f.token(WORK));
            assertEquals(86, f.prepare());
            Node pass = uri("urn:pass:all-private-owners"); f.begin(WORK, pass);
            var first = f.advance(pass); assertEquals(64, first.visited()); assertEquals(64, first.owners().size()); assertFalse(first.complete());
            var rest = f.drain(pass); assertEquals(86, rest.size());
            var unique = new HashSet<Node>(); first.owners().forEach(o -> unique.add(o.slot())); rest.forEach(o -> unique.add(o.slot()));
            assertEquals(150, unique.size());
        }
    }

    @Test public void finiteTurnsCountDeadLinksAndPrivateOwnersWithoutPopulationReads() {
        try (var f = new Fixture()) {
            var slots = new ArrayList<Node>();
            f.raw(d -> { for (int i = 0; i < 150; i++) slots.add(owner(d, i, WORK, MAIN)); });
            f.prepare();
            for (int start = 0; start < 100; start += 50) {
                int offset = start;
                f.nativeWrite(d -> { for (int i = offset; i < offset + 50; i++) d.deleteAny(CURRENT, slots.get(i), Node.ANY, Node.ANY); });
            }
            Node pass = uri("urn:pass:dead-links"); f.begin(WORK, pass);
            int visited = 0; var active = new HashSet<Node>(); long maxRows = 0;
            for (int step = 0; step < 4; step++) {
                Node receipt = uri("urn:receipt:dead-links:" + step);
                var result = f.write(() -> {
                    var measured = new Measured(f.data);
                    try (var work = new CommandWork()) {
                        var turn = PublicNameProjection.advanceWorkScope(measured, pass, receipt);
                        assertEquals("dead links are physical work too", turn.visited(), counter(work, "work_name_scope_links_visited"));
                        assertTrue("point rows exceeded fixed owner budget: " + measured.rows, measured.rows <= 64 * 12 + 128);
                        return new Object[]{turn, measured.rows};
                    }
                });
                var turn = (PublicNameProjection.ScopeTurn) result[0]; maxRows = Math.max(maxRows, (Long) result[1]);
                assertTrue(turn.visited() <= 64); visited += turn.visited(); turn.owners().forEach(o -> active.add(o.slot()));
                if (turn.complete()) break;
            }
            assertEquals(150, visited); assertEquals(50, active.size()); assertTrue(f.complete(pass));
            System.out.println("Work scope links=150 dead=100 active=50 maxPointRows=" + maxRows);
        }
    }

    @Test public void lateInsertionBehindAnAdvancedCursorInvalidatesEofAndACompletePass() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 100; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node pass = uri("urn:pass:before-insert"); f.begin(WORK, pass); assertEquals(64, f.advance(pass).visited());
            String prior = f.basis(WORK); f.nativeWrite(d -> owner(d, 1000, WORK, MAIN)); assertNotEquals(prior, f.basis(WORK));
            assertFalse(f.complete(pass)); assertThrows(IllegalStateException.class, () -> f.advance(pass));
            Node next = uri("urn:pass:after-insert"); f.begin(WORK, next); assertEquals(101, f.drain(next).size());
            f.nativeWrite(d -> owner(d, 1001, WORK, MAIN)); assertFalse(f.complete(next));
        }
    }

    @Test public void reassignmentDeletionHeadAndTypeRemovalAdvanceOldAndNewLocalBases() {
        try (var f = new Fixture()) {
            Node slot = f.write(() -> owner(f.data, 0, WORK, MAIN)); f.prepare();
            String oldWork = f.basis(WORK), oldOther = f.basis(OTHER);
            f.nativeWrite(d -> replace(d, CURRENT, slot, p("work"), OTHER));
            assertNotEquals(oldWork, f.basis(WORK)); assertNotEquals(oldOther, f.basis(OTHER));
            Node oldPass = uri("urn:pass:moved-away"), newPass = uri("urn:pass:moved-here");
            f.begin(WORK, oldPass); f.begin(OTHER, newPass);
            assertTrue(f.drain(oldPass).isEmpty()); assertEquals(slot, f.drain(newPass).getFirst().slot());
            String beforeHead = f.basis(OTHER); f.nativeWrite(d -> replace(d, CURRENT, slot, p("selectionHead"), id(90000)));
            assertNotEquals(beforeHead, f.basis(OTHER)); assertFalse(f.complete(newPass));
            Node headed = uri("urn:pass:new-head"); f.begin(OTHER, headed); assertEquals(id(90000), f.drain(headed).getFirst().head());
            String beforeType = f.basis(OTHER); f.nativeWrite(d -> d.delete(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot")));
            assertNotEquals(beforeType, f.basis(OTHER)); assertFalse(f.complete(headed));
            Node removed = uri("urn:pass:removed-type"); f.begin(OTHER, removed); assertTrue(f.drain(removed).isEmpty());
            String beforeReadd = f.basis(OTHER); f.nativeWrite(d -> d.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot")));
            assertNotEquals(beforeReadd, f.basis(OTHER));
            Node readded = uri("urn:pass:readded-type"); f.begin(OTHER, readded); assertEquals(1, f.drain(readded).size());
            String last = f.basis(OTHER); f.nativeWrite(d -> d.deleteAny(CURRENT, slot, Node.ANY, Node.ANY));
            assertNotEquals(last, f.basis(OTHER)); assertFalse(f.complete(readded));
        }
    }

    @Test public void rollbackAndReceiptReplayPreserveTheExactPassSourceAndBasis() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node source = f.token(WORK); String basis = f.basis(WORK), passName = "urn:pass:replay";
            Node pass = uri(passName), receipt = uri("urn:receipt:first-pass-turn"); f.begin(WORK, pass);
            assertEquals(64, f.write(() -> PublicNameProjection.advanceWorkScope(f.data, pass, receipt)).visited());
            var replay = f.write(() -> PublicNameProjection.advanceWorkScope(f.data, pass, receipt));
            assertTrue(replay.replayed()); assertEquals(0, replay.visited()); assertFalse(replay.complete());
            f.data.begin(ReadWrite.WRITE);
            try { assertEquals(64, PublicNameProjection.advanceWorkScope(f.data, pass, uri("urn:receipt:aborted-turn")).visited()); f.data.abort(); }
            finally { f.data.end(); }
            assertEquals(64, f.write(() -> PublicNameProjection.advanceWorkScope(f.data, pass, uri("urn:receipt:aborted-turn"))).visited());
            assertEquals(22, f.drain(pass).size());
            f.data.begin(ReadWrite.WRITE);
            try {
                f.append(f.data, d -> { owner(d, 1000, WORK, MAIN); d.add(CURRENT, WORK, NAMES.get(2), text("Aborted alias")); });
                assertNotEquals(source, PublicNameProjection.nameSourceToken(f.data, WORK));
                assertNotEquals(basis, TemplateIndexService.workAdoptionBasis(f.data, WORK));
                f.data.abort();
            } finally { f.data.end(); }
            assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK)); assertTrue(f.complete(pass));
            // Reusing the pass is a replay, not a cursor reset.
            f.begin(WORK, pass); assertTrue(f.complete(pass));
        }
    }

    @Test public void sixActualSourcePredicatesChangeOnlyTheirOwnerWithoutAWorkHeadMove() {
        try (var f = new Fixture()) {
            f.prepare(); Node other = f.token(OTHER);
            for (int i = 0; i < NAMES.size(); i++) {
                Node predicate = NAMES.get(i), value = NodeFactory.createLiteralLang("Authored name " + i, "fr");
                Node before = f.token(WORK); f.nativeWrite(d -> d.add(CURRENT, WORK, predicate, value)); assertNotEquals(before, f.token(WORK));
                Node added = f.token(WORK); f.nativeWrite(d -> d.add(CURRENT, WORK, predicate, value)); assertEquals(added, f.token(WORK));
                f.nativeWrite(d -> { d.delete(CURRENT, WORK, predicate, value); d.add(CURRENT, WORK, predicate, value); });
                assertEquals("net-identical source must not invalidate", added, f.token(WORK));
                f.nativeWrite(d -> d.delete(CURRENT, WORK, predicate, value)); assertNotEquals(added, f.token(WORK));
                assertEquals(other, f.token(OTHER));
            }
            Node stable = f.token(WORK);
            f.nativeWrite(d -> { d.add(CURRENT, OTHER, NAMES.get(2), text("Other Work alias"));
                d.add(PUBLIC, PublicNameProjection.nameUnit(WORK, "work"), p("publicTitle"), text("Derived title"));
                d.add(PublicNameProjection.REPAIR, uri("urn:ack:derived"), p("scopeAcknowledged"), text("done")); });
            assertEquals(stable, f.token(WORK)); assertNotEquals(other, f.token(OTHER));
        }
    }

    @Test public void currentHeaderPayloadPointerAndErasureChangeSourceWithoutChangingWorkHead() {
        try (var f = new Fixture()) {
            Node revision = id(500), component = id(501), next = id(502), futureComponent = id(503);
            f.raw(d -> { header(d, WORK, revision, component, payload("Premier")); d.add(CURRENT, WORK, p("descriptiveMetadataHead"), revision); }); f.prepare();
            Node source = f.token(WORK);
            f.nativeWrite(d -> replace(d, REVISIONS, revision, p("metadataState"), text(payload("Deuxième"))));
            assertNotEquals(source, f.token(WORK)); source = f.token(WORK);
            f.nativeWrite(d -> { header(d, WORK, next, futureComponent, payload("Future")); });
            assertEquals("an unselected header is not the current name source", source, f.token(WORK));
            f.nativeWrite(d -> replace(d, CURRENT, WORK, p("descriptiveMetadataHead"), next)); assertNotEquals(source, f.token(WORK)); source = f.token(WORK);
            f.nativeWrite(d -> d.add(REVISIONS, next, RDF.type.asNode(), p("ErasedRevision"))); assertNotEquals(source, f.token(WORK));
            f.nativeWrite(d -> d.delete(CURRENT, futureComponent, p("work"), WORK));
            assertThrows(IllegalStateException.class, () -> f.token(WORK));
        }
    }

    @Test public void aRawHeaderWithoutAnExactBacklinkCannotAcquireAnEofCertificate() {
        try (var f = new Fixture()) {
            f.prepare(); Node pass = uri("urn:pass:before-malformed-header"); f.begin(WORK, pass); f.drain(pass);
            f.nativeWrite(d -> { d.add(CURRENT, WORK, p("descriptiveMetadataHead"), id(500));
                d.add(REVISIONS, id(500), p("metadataState"), text(payload("Unowned"))); });
            assertFalse(f.complete(pass)); assertThrows(IllegalStateException.class, () -> f.token(WORK));
        }
    }

    @Test public void workTypeRemovalAndReadditionCannotReviveAnOldSourceCertificate() {
        try (var f = new Fixture()) {
            f.prepare(); Node source = f.token(WORK), pass = uri("urn:pass:before-work-retirement"); f.begin(WORK, pass); f.drain(pass);
            Node kind = uri("https://schema.org/CreativeWork");
            f.nativeWrite(d -> d.delete(CURRENT, WORK, RDF.type.asNode(), kind)); assertFalse(f.complete(pass));
            f.nativeWrite(d -> d.add(CURRENT, WORK, NAMES.get(2), text("Alias while untyped")));
            f.nativeWrite(d -> d.add(CURRENT, WORK, RDF.type.asNode(), kind));
            assertNotEquals(source, f.token(WORK)); assertFalse(f.complete(pass));
        }
    }

    @Test public void controlledRawUncertaintyAndEpochChangesRefuseCompletionUntilColdRequalification() {
        try (var f = new Fixture()) {
            f.raw(d -> owner(d, 0, WORK, MAIN)); f.prepare(); Node pass = uri("urn:pass:before-raw"); f.begin(WORK, pass); f.drain(pass);
            f.raw(d -> d.add(CURRENT, WORK, NAMES.get(2), text("Unobserved alias")));
            assertFalse(f.complete(pass)); assertThrows(IllegalStateException.class, () -> f.token(WORK)); assertThrows(IllegalStateException.class, () -> f.advance(pass));
            f.prepare(); assertFalse(f.complete(pass)); Node fresh = uri("urn:pass:after-raw"); f.begin(WORK, fresh); assertEquals(1, f.drain(fresh).size());
            f.nativeWrite(d -> replace(d, CONTROL, PRODUCT, p("dataEpoch"), text("44444444-4444-4444-8444-444444444444")));
            assertFalse(f.complete(fresh)); assertThrows(IllegalStateException.class, () -> f.advance(fresh));
            f.prepare(); Node restored = uri("urn:pass:new-epoch"); f.begin(WORK, restored); assertEquals(1, f.drain(restored).size());
        }
    }

    private static Set<Quad> singleton(DatasetGraph data) {
        var rows = data.find(uri(PublicNameProjection.workScopeRepairGraph()),
            uri(PublicNameProjection.PREFIX + "work-scope-directory"), Node.ANY, Node.ANY);
        try { return Set.copyOf(org.apache.jena.atlas.iterator.Iter.toList(rows)); }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    @Test public void unrelatedOrdinaryWritesAndCursorTurnsNeverStampSingletonCorrectnessState() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 70; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node source = f.token(WORK), pass = uri("urn:pass:local-proof"); String basis = f.basis(WORK);
            Set<Quad> before = f.read(() -> singleton(f.data)); assertFalse(before.isEmpty());
            assertTrue(before.stream().noneMatch(q -> q.getPredicate().equals(p("scopeVersion"))));
            f.begin(WORK, pass); f.advance(pass);
            f.nativeWrite(d -> d.add(CURRENT, OTHER, NAMES.get(2), text("Unrelated actual source mutation")));
            assertEquals(before, f.read(() -> singleton(f.data)));
            assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
            assertEquals(6, f.drain(pass).size()); assertTrue(f.complete(pass));
            assertEquals(before, f.read(() -> singleton(f.data)));
            System.out.println("Work scope locality unrelatedSingletonWrites=0 scopeVersion=absent remaining=6");
        }
    }
    @Test public void unknownWriterCannotPrepareOrCertifyEvenWithForgedCurrentStoreProof() {
        try (var original = new Fixture(); var unknown = new Fixture(false)) {
            original.prepare(); Node pass = uri("urn:pass:unknown-writer"); original.begin(WORK, pass); original.drain(pass);
            List<Quad> snapshot = original.read(() -> org.apache.jena.atlas.iterator.Iter.toList(original.data.find()));
            unknown.write(() -> {
                unknown.data.clear(); snapshot.forEach(unknown.data::add);
                replace(unknown.data, uri(PublicNameProjection.workScopeRepairGraph()),
                    uri(PublicNameProjection.PREFIX + "work-scope-directory"), p("scopeStore"), text(TemplateIndexService.workScopeStore(unknown.data)));
                return null;
            });
            assertFalse(unknown.complete(pass));
            assertThrows(IllegalStateException.class, () -> unknown.token(WORK));
            assertThrows(IllegalStateException.class, unknown::prepare);
            assertThrows(IllegalStateException.class, () -> unknown.advance(pass));
            // A later configuration exposing an unknown writer must also close
            // admission for an already prepared physical store.
            assertTrue(original.complete(pass));
            TemplateIndexService.withdrawWorkScopeWriter(original.data);
            assertFalse(original.complete(pass));
            assertThrows(IllegalStateException.class, () -> original.token(WORK));
            assertThrows(IllegalStateException.class, original::prepare);
        }
    }
    @Test public void exclusiveStartupAndAbortedRawUncertaintyPreserveTheirTransactionBoundary() {
        try (var f = new Fixture()) {
            f.prepare(); Node source = f.token(WORK), pass = uri("urn:pass:startup-boundary"); f.begin(WORK, pass); f.drain(pass);
            Set<Quad> before = f.read(() -> singleton(f.data));
            assertThrows(IllegalStateException.class, () -> f.write(() -> {
                PublicNameProjection.invalidateWorkScopeQualification(f.data);
                f.data.add(CURRENT, WORK, NAMES.get(2), text("Aborted raw alias"));
                throw new IllegalStateException("abort uncertainty with raw mutation");
            }));
            assertEquals(before, f.read(() -> singleton(f.data))); assertEquals(source, f.token(WORK)); assertTrue(f.complete(pass));
            f.write(() -> { PublicNameProjection.workScopeExclusiveStartup(f.data); return null; });
            assertFalse(f.complete(pass)); assertThrows(IllegalStateException.class, () -> f.token(WORK));
            f.prepare(); assertFalse(f.complete(pass)); assertNotEquals(source, f.token(WORK));
        }
    }
    @Test public void controlledRawRouteRejectsProofForgeryAndTransactionallyRefusesOldEof() throws Exception {
        try (var f = new Fixture()) {
            f.raw(d -> owner(d, 0, WORK, MAIN)); f.prepare();
            Node pass = uri("urn:pass:raw-route"), source = f.token(WORK); f.begin(WORK, pass); f.drain(pass);
            var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data", f.data)
                .registerOperation(org.apache.jena.fuseki.server.Operation.Update, new TemplateIndexService.RawMembershipUpdate()).build().start();
            try {
                var client = java.net.http.HttpClient.newHttpClient();
                var address = java.net.URI.create("http://127.0.0.1:" + server.getPort() + "/data/update");
                Set<Quad> before = f.read(() -> singleton(f.data));
                for (String rejected : List.of(
                    "INSERT DATA { GRAPH <" + PublicNameProjection.workScopeRepairGraph() + "> { <"
                        + PublicNameProjection.PREFIX + "work-scope-directory> <" + p("scopePhase").getURI() + "> \"complete\" } }",
                    "INSERT { GRAPH ?g { <urn:forged> <urn:predicate> \"value\" } } WHERE { BIND(<"
                        + PublicNameProjection.workScopeRepairGraph() + "> AS ?g) }",
                    "DELETE WHERE { GRAPH <" + PublicNameProjection.workScopeRepairGraph() + "> { <" + WORK.getURI()
                        + "> <" + p("scopeLinkHead").getURI() + "> ?head } }",
                    "DELETE DATA { GRAPH <" + PublicNameProjection.workScopeRepairGraph() + "> { <" + WORK.getURI()
                        + "> <" + p("scopeLinkCount").getURI() + "> \"1\" } }",
                    "DELETE { GRAPH ?g { ?s ?p ?o } } WHERE { GRAPH ?g { ?s ?p ?o } }",
                    "CLEAR GRAPH <" + PublicNameProjection.workScopeRepairGraph() + ">",
                    "DROP GRAPH <" + PublicNameProjection.workScopeRepairGraph() + ">",
                    "CLEAR ALL", "DROP NAMED",
                    "LOAD <urn:unknown-bypass>")) {
                    var request = java.net.http.HttpRequest.newBuilder(address).header("Content-Type", "application/sparql-update")
                        .timeout(java.time.Duration.ofSeconds(10)).POST(java.net.http.HttpRequest.BodyPublishers.ofString(rejected)).build();
                    var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
                    assertEquals(response.body(), 400, response.statusCode());
                    assertEquals(before, f.read(() -> singleton(f.data))); assertTrue(f.complete(pass));
                }
                String update = "INSERT DATA { GRAPH <" + CURRENT.getURI() + "> { <" + WORK.getURI() + "> <"
                    + NAMES.get(2).getURI() + "> \"Controlled raw alias\" } }; # trailing maintenance comment\n";
                var request = java.net.http.HttpRequest.newBuilder(address).header("Content-Type", "application/sparql-update")
                    .timeout(java.time.Duration.ofSeconds(10)).POST(java.net.http.HttpRequest.BodyPublishers.ofString(update)).build();
                var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
                assertTrue(response.body(), response.statusCode() == 200 || response.statusCode() == 204);
                assertFalse(f.complete(pass)); assertThrows(IllegalStateException.class, () -> f.token(WORK));
                assertThrows(IllegalStateException.class, () -> f.advance(pass));
                f.prepare(); assertFalse(f.complete(pass)); assertNotEquals(source, f.token(WORK));
                System.out.println("Work scope controlledRaw=unqualified proofForgery=denied unknownBypass=denied");
            } finally { server.stop(); }
        }
    }

    @Test public void aCopiedPhysicalStoreCannotReuseAnOldCursorOrQualification() {
        try (var original = new Fixture(); var copy = new Fixture()) {
            original.raw(d -> { for (int i = 0; i < 70; i++) owner(d, i, WORK, MAIN); }); original.prepare();
            Node pass = uri("urn:pass:old-physical-store"); original.begin(WORK, pass); assertEquals(64, original.advance(pass).visited());
            List<Quad> snapshot = original.read(() -> org.apache.jena.atlas.iterator.Iter.toList(original.data.find()));
            copy.raw(d -> { d.clear(); snapshot.forEach(d::add); });
            assertFalse(copy.complete(pass)); assertThrows(IllegalStateException.class, () -> copy.advance(pass));
            copy.prepare(); Node fresh = uri("urn:pass:copied-store"); copy.begin(WORK, fresh); assertEquals(70, copy.drain(fresh).size());
        }
    }

    private static List<Long> sourceWriteCost(int names, int unrelated) {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < names; i++) d.add(CURRENT, WORK, NAMES.get(2), text("Existing alias " + i));
                for (int i = 0; i < unrelated; i++) d.add(CURRENT, OTHER, NAMES.get(2), text("Unrelated alias " + i)); }); f.prepare();
            Node source = f.token(WORK);
            var counts = f.write(() -> {
                var measured = new Measured(f.data);
                f.append(measured, d -> d.add(CURRENT, WORK, NAMES.get(2), text("One new alias")));
                return List.of(measured.probes, measured.rows);
            });
            assertNotEquals(source, f.token(WORK));
            assertTrue("source point rows must stay fixed", counts.get(1) < 128);
            System.out.println("Work source aliases=" + names + " unrelated=" + unrelated + " probes=" + counts.get(0) + " rows=" + counts.get(1));
            return counts;
        }
    }
    @Test public void sourceEffectPointWorkDoesNotGrowWithNameOrUnrelatedInventories() {
        assertEquals(sourceWriteCost(1, 0), sourceWriteCost(1001, 2100));
    }
    private static List<Long> adoptionWriteCost(int unrelated) {
        try (var f = new Fixture()) {
            f.raw(d -> { owner(d, 0, WORK, MAIN);
                for (int i = 0; i < unrelated; i++) owner(d, 1000 + i, OTHER, OTHER_MAIN); });
            f.prepare(); String before = f.basis(WORK), other = f.basis(OTHER);
            var cost = f.write(() -> {
                var measured = new Measured(f.data);
                f.append(measured, d -> owner(d, 9000, WORK, MAIN));
                return List.of(measured.probes, measured.rows);
            });
            assertNotEquals(before, f.basis(WORK)); assertEquals(other, f.basis(OTHER));
            assertTrue("owner snapshot exceeded fixed point-row ceiling", cost.get(1) < 512);
            Node pass = uri("urn:pass:two-owned-slots"); f.begin(WORK, pass); assertEquals(2, f.drain(pass).size());
            System.out.println("Work adoption unrelated=" + unrelated + " probes=" + cost.get(0) + " rows=" + cost.get(1));
            return cost;
        }
    }
    @Test public void adoptionWriteSnapshotsDoNotReadTheOwnerOrUnrelatedPopulation() {
        assertEquals(adoptionWriteCost(1), adoptionWriteCost(1500));
    }
    @Test public void sourceOwnerTransactionOverflowAbortsWithoutChangingSourceBasisOrEof() {
        try (var f = new Fixture()) {
            var sources = new ArrayList<Node>();
            f.raw(d -> {
                owner(d, 0, WORK, MAIN);
                for (int i = 0; i < 65; i++) {
                    Node work = id(300000 + i * 2); sources.add(work); work(d, work, id(300001 + i * 2));
                }
            });
            f.prepare(); Node token = f.token(WORK); String basis = f.basis(WORK);
            Node pass = uri("urn:pass:before-source-overflow"); f.begin(WORK, pass); f.drain(pass);
            f.data.begin(ReadWrite.WRITE);
            try {
                assertThrows(IllegalArgumentException.class, () -> f.append(f.data, d -> {
                    for (Node source : sources) d.add(CURRENT, source, NAMES.get(2), text("Aborted source-owner overflow"));
                }));
                f.data.abort();
            } finally { f.data.end(); }
            assertEquals(token, f.token(WORK)); assertEquals(basis, f.basis(WORK)); assertTrue(f.complete(pass));
            f.read(() -> {
                for (Node source : sources) assertFalse(f.data.contains(CURRENT, source, NAMES.get(2), text("Aborted source-owner overflow")));
                return null;
            });
        }
    }
    @Test public void routingAndRestoreHoldFencePassesWhileColdPreparationRemainsBounded() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node original = uri("urn:pass:before-restore-hold"); f.begin(WORK, original); f.drain(original);
            Node held = NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean);
            f.nativeWrite(d -> {
                replace(d, CONTROL, PRODUCT, p("dataEpoch"), text("44444444-4444-4444-8444-444444444444"));
                d.add(CONTROL, PRODUCT, p("restoreHold"), held);
            });
            assertFalse(f.complete(original)); assertThrows(IllegalStateException.class, () -> f.token(WORK));
            assertThrows(IllegalStateException.class, () -> f.begin(WORK, uri("urn:pass:forbidden-under-hold")));
            int first = f.write(() -> {
                try (var measured = new CommandWork()) {
                    int visited = PublicNameProjection.prepareWorkScopeDirectory(f.data);
                    assertEquals(64, counter(measured, "work_name_scope_cold_tuples"));
                    return visited;
                }
            });
            assertEquals(64, first); assertEquals(86, f.prepare());
            assertThrows("a prepared directory must not release the restore fence", IllegalStateException.class, () -> f.token(WORK));
            assertFalse(f.complete(original));
            f.nativeWrite(d -> d.delete(CONTROL, PRODUCT, p("restoreHold"), held));
            Node released = uri("urn:pass:released-restore"); f.begin(WORK, released); assertEquals(150, f.drain(released).size());
            f.nativeWrite(d -> replace(d, CONTROL, PRODUCT, p("routingEpoch"), text("55555555-5555-4555-8555-555555555555")));
            assertFalse(f.complete(released)); assertThrows(IllegalStateException.class, () -> f.advance(released));
            assertThrows(IllegalStateException.class, () -> f.token(WORK));
            assertEquals(150, f.prepare());
            Node routed = uri("urn:pass:new-routing-epoch"); f.begin(WORK, routed); assertEquals(150, f.drain(routed).size());
            assertFalse("cold requalification never revives the earlier pass", f.complete(released));
        }
    }
    private static Set<Quad> bookkeeping(DatasetGraph data) {
        var quads = new HashSet<Quad>();
        for (Node graph : List.of(PublicNameProjection.REPAIR, uri(TemplateIndexService.STATE))) {
            var rows = data.find(graph, Node.ANY, Node.ANY, Node.ANY);
            try { rows.forEachRemaining(quads::add); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        return quads;
    }

    @Test public void expiredScopeBudgetsPreserveThePartialCursorAndItsRemainingEightySixOwners() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node pass = uri("urn:pass:expired-scope"); f.begin(WORK, pass); assertEquals(64, f.advance(pass).visited());
            Node source = f.token(WORK); String basis = f.basis(WORK); Set<Quad> before = f.read(() -> bookkeeping(f.data));
            assertThrows(CancellationException.class, () -> f.write(() -> PublicNameProjection.advanceWorkScope(
                f.data, pass, uri("urn:receipt:expired-scope-turn"), Long.MIN_VALUE)));
            assertThrows(CancellationException.class, () -> f.write(() -> PublicNameProjection.prepareWorkScopeDirectory(f.data, Long.MIN_VALUE)));
            assertThrows(CancellationException.class, () -> f.write(() -> {
                PublicNameProjection.beginWorkScope(f.data, WORK, uri("urn:pass:expired-begin"), Long.MIN_VALUE); return null;
            }));
            assertThrows(CancellationException.class, () -> f.read(() -> PublicNameProjection.nameSourceToken(f.data, WORK, Long.MIN_VALUE)));
            assertThrows(CancellationException.class, () -> f.read(() -> PublicNameProjection.workScopeComplete(f.data, pass, Long.MIN_VALUE)));
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
            assertFalse(f.complete(pass)); assertEquals(86, f.drain(pass).size());
        }
    }

    @Test public void expiredAppendAfterPrimaryWritesAbortsSourceBasisAndQualificationChanges() {
        try (var f = new Fixture()) {
            f.raw(d -> owner(d, 0, WORK, MAIN)); f.prepare();
            Node pass = uri("urn:pass:before-expired-append"); f.begin(WORK, pass); f.drain(pass);
            Node source = f.token(WORK); String basis = f.basis(WORK); Set<Quad> before = f.read(() -> bookkeeping(f.data));
            Node addedSlot = CanonicalPolicy.realmOwner(id(10000), MAIN);
            assertThrows(CancellationException.class, () -> f.write(() -> {
                var capture = new SearchDeltaJournal.Capture(f.data);
                DatasetGraph observed = capture.observed(); owner(observed, 9000, WORK, MAIN);
                observed.add(CURRENT, WORK, NAMES.get(2), text("Expired proposed alias"));
                SearchDeltaJournal.append(f.data, capture, 2L, Long.MIN_VALUE); return null;
            }));
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
            assertTrue(f.complete(pass));
            f.read(() -> {
                assertFalse(f.data.contains(CURRENT, addedSlot, RDF.type.asNode(), p("RealmPublicationSlot")));
                assertFalse(f.data.contains(CURRENT, WORK, NAMES.get(2), text("Expired proposed alias"))); return null;
            });
        }
    }

    @Test public void interruptionAfterTheThirdLinkRollsBackTheCursorAndResumesAllRemainingOwners() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node pass = uri("urn:pass:interrupted-links"); f.begin(WORK, pass); assertEquals(64, f.advance(pass).visited());
            Set<Quad> before = f.read(() -> bookkeeping(f.data)); Node source = f.token(WORK); String basis = f.basis(WORK);
            int[] links = {0};
            try {
                assertThrows(CancellationException.class, () -> f.write(() -> {
                    var measured = new DatasetGraphWrapper(new Measured(f.data)) {
                        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
                            return org.apache.jena.atlas.iterator.Iter.map(super.find(graph, subject, predicate, object), quad -> {
                                if (graph.equals(PublicNameProjection.REPAIR) && predicate.equals(p("scopeSlot")) && ++links[0] == 3)
                                    Thread.currentThread().interrupt();
                                return quad;
                            });
                        }
                    };
                    return PublicNameProjection.advanceWorkScope(measured, pass, uri("urn:receipt:interrupted-links"));
                }));
                assertEquals(3, links[0]); assertTrue("the implementation must preserve cancellation", Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
            assertEquals(86, f.drain(pass).size());
        }
    }

    @Test public void interruptionDuringTheRetainedSourceEffectScanLeavesNoPartialSourceOrOwnerEffect() {
        try (var f = new Fixture()) {
            f.raw(d -> owner(d, 0, WORK, MAIN)); f.prepare();
            Node pass = uri("urn:pass:before-source-scan-interrupt"); f.begin(WORK, pass); f.drain(pass);
            Set<Quad> before = f.read(() -> bookkeeping(f.data)); Node source = f.token(WORK); String basis = f.basis(WORK);
            boolean[] armed = {false}; int[] checks = {0};
            try {
                assertThrows(CancellationException.class, () -> f.write(() -> {
                    var measured = new DatasetGraphWrapper(new Measured(f.data)) {
                        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                            boolean found = super.contains(graph, subject, predicate, object);
                            if (armed[0] && graph.equals(CURRENT) && subject.equals(WORK) && predicate.equals(NAMES.get(2)) && ++checks[0] == 2)
                                Thread.currentThread().interrupt();
                            return found;
                        }
                    };
                    var capture = new SearchDeltaJournal.Capture(measured, false, Long.MAX_VALUE);
                    DatasetGraph observed = capture.observed(); owner(observed, 9000, WORK, MAIN);
                    for (int i = 0; i < 3; i++) observed.add(CURRENT, WORK, NAMES.get(2), text("Interrupted effect " + i));
                    armed[0] = true;
                    SearchDeltaJournal.append(measured, capture, 2L, Long.MAX_VALUE); return null;
                }));
                assertEquals(2, checks[0]); assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK)); assertTrue(f.complete(pass));
            f.read(() -> {
                for (int i = 0; i < 3; i++) assertFalse(f.data.contains(CURRENT, WORK, NAMES.get(2), text("Interrupted effect " + i)));
                return null;
            });
        }
    }

    @Test public void interruptionAfterNewBasisAndSourceMutationRollsBackBothGenerations() {
        try (var f = new Fixture()) {
            f.raw(d -> owner(d, 0, WORK, MAIN)); f.prepare();
            Node pass = uri("urn:pass:before-generation-interrupt"); f.begin(WORK, pass); f.drain(pass);
            Set<Quad> before = f.read(() -> bookkeeping(f.data)); Node source = f.token(WORK); String basis = f.basis(WORK);
            boolean[] changed = {false};
            try {
                assertThrows(CancellationException.class, () -> f.write(() -> {
                    var measured = new DatasetGraphWrapper(new Measured(f.data)) {
                        @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                            super.add(graph, subject, predicate, object);
                            if (graph.equals(PublicNameProjection.REPAIR) && subject.equals(WORK) && predicate.equals(p("scopeNameSource"))) {
                                assertNotEquals("the owner basis already changed", basis, TemplateIndexService.workAdoptionBasis(this, WORK));
                                assertNotEquals("the source token already changed", source, PublicNameProjection.nameSourceToken(this, WORK));
                                changed[0] = true; Thread.currentThread().interrupt();
                            }
                        }
                    };
                    var capture = new SearchDeltaJournal.Capture(measured, false, Long.MAX_VALUE);
                    DatasetGraph observed = capture.observed(); owner(observed, 9000, WORK, MAIN);
                    observed.add(CURRENT, WORK, NAMES.get(2), text("Interrupted after generations"));
                    SearchDeltaJournal.append(measured, capture, 2L, Long.MAX_VALUE); return null;
                }));
                assertTrue("interruption occurred after both native mutations", changed[0]); assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK)); assertTrue(f.complete(pass));
        }
    }

    @Test public void completionPropagatesCancellationInsteadOfReturningTrueOrFalse() {
        for (String predicate : List.of("scopeCursor", "scopeRemaining")) try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); }); f.prepare();
            Node pass = uri("urn:pass:completion-interrupt:" + predicate); f.begin(WORK, pass);
            if (predicate.equals("scopeCursor")) assertEquals(64, f.advance(pass).visited()); else f.drain(pass);
            Set<Quad> before = f.read(() -> bookkeeping(f.data)); boolean[] reached = {false};
            try {
                assertThrows(CancellationException.class, () -> f.read(() -> {
                    var measured = new DatasetGraphWrapper(new Measured(f.data)) {
                        @Override public Iterator<Quad> find(Node graph, Node subject, Node property, Node object) {
                            return org.apache.jena.atlas.iterator.Iter.map(super.find(graph, subject, property, object), quad -> {
                                if (graph.equals(PublicNameProjection.REPAIR) && subject.equals(pass) && property.equals(p(predicate))) {
                                    reached[0] = true; Thread.currentThread().interrupt();
                                }
                                return quad;
                            });
                        }
                    };
                    return PublicNameProjection.workScopeComplete(measured, pass);
                }));
                assertTrue(reached[0]); assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data)));
            assertEquals(predicate.equals("scopeRemaining"), f.complete(pass));
        }
    }

    @Test public void interruptedColdLinkPreparationCannotPublishItsPartialQualification() {
        try (var f = new Fixture()) {
            f.raw(d -> { for (int i = 0; i < 150; i++) owner(d, i, WORK, MAIN); });
            Set<Quad> before = f.read(() -> bookkeeping(f.data)); int[] links = {0};
            try {
                assertThrows(CancellationException.class, () -> f.write(() -> {
                    var measured = new DatasetGraphWrapper(f.data) {
                        @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                            super.add(graph, subject, predicate, object);
                            if (graph.equals(PublicNameProjection.REPAIR) && predicate.equals(p("scopeWork")) && ++links[0] == 3)
                                Thread.currentThread().interrupt();
                        }
                    };
                    return PublicNameProjection.prepareWorkScopeDirectory(measured);
                }));
                assertEquals(3, links[0]); assertTrue(Thread.currentThread().isInterrupted());
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data))); assertThrows(IllegalStateException.class, () -> f.token(WORK));
            assertEquals(150, f.prepare()); Node pass = uri("urn:pass:after-interrupted-cold-preparation");
            f.begin(WORK, pass); assertEquals(150, f.drain(pass).size());
        }
    }
    private static Set<Node> recipeLiterals(Fixture f, Node snapshot) {
        return f.read(() -> {
            Set<Node> result = new HashSet<>();
            var rows = f.data.find(PublicNameProjection.REPAIR, snapshot, PublicNameProjection.WORK_NAME_RECIPE_LITERAL, Node.ANY);
            try { rows.forEachRemaining(quad -> result.add(quad.getObject())); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            return result;
        });
    }
    private static Node recipe(Fixture f, String name) {
        return f.write(() -> PublicNameProjection.beginWorkNameRecipe(f.data, WORK, uri("urn:recipe:begin:" + name), Long.MAX_VALUE));
    }
    private static PublicNameProjection.RecipeTurn recipeTurn(Fixture f, Node snapshot, String receipt) {
        return f.write(() -> PublicNameProjection.advanceWorkNameRecipe(f.data, snapshot, uri(receipt), Long.MAX_VALUE));
    }
    private static void drainRecipe(Fixture f, Node snapshot) {
        for (int turn = 0; turn < 100; turn++) {
            var result = recipeTurn(f, snapshot, "urn:recipe:drain:" + ++f.receipt);
            assertTrue(result.sourceValues() + result.lookahead() + result.copies() <= 64);
            if (result.complete()) return;
        }
        fail("bounded recipe did not finish");
    }

    @Test public void currentRecipeSnapshotsAllSixPredicatesAndPagedHeaderWithoutUnrelatedPopulationWork() {
        long[] baseline = null;
        for (int unrelated : new int[] {0, 320, 4096}) try (var f = new Fixture()) {
            Set<Node> expected = new HashSet<>();
            f.raw(data -> {
                data.deleteAny(CURRENT, WORK, LABEL, Node.ANY);
                for (int predicate = 0; predicate < NAMES.size(); predicate++) for (int value = 0; value < 70; value++) {
                    Node literal = value == 0 ? NodeFactory.createLiteralLang("共通 🧪", "ja")
                        : value % 2 == 0 ? NodeFactory.createLiteralLang("名称 " + predicate + ":" + value + " 🧪", "zh-Hant")
                        : NodeFactory.createLiteralDT("typed " + predicate + ":" + value,
                            org.apache.jena.datatypes.TypeMapper.getInstance().getSafeTypeByName("urn:recipe:datatype"));
                    data.add(CURRENT, WORK, NAMES.get(predicate), literal); expected.add(literal);
                }
                data.add(CURRENT, WORK, NAMES.get(2), uri("urn:recipe:nonliteral"));
                var localized = new org.apache.jena.atlas.json.JsonArray();
                for (int i = 0; i < 145; i++) {
                    var item = new org.apache.jena.atlas.json.JsonObject(); item.put("language", "fr");
                    if (i % 9 == 0) item.put("title", org.apache.jena.atlas.json.JsonNull.instance);
                    else { item.put("title", "Entête 🧪 " + i); expected.add(NodeFactory.createLiteralLang("Entête 🧪 " + i, "fr")); }
                    localized.add(item);
                }
                String payload = "{\"kind\":\"header\",\"originalTitle\":{\"value\":\"原題\",\"language\":\"ja\"},\"localized\":" + localized + "}";
                expected.add(NodeFactory.createLiteralLang("原題", "ja"));
                header(data, WORK, id(600), id(601), payload);
                data.add(CURRENT, WORK, p("descriptiveMetadataHead"), id(600));
                for (int i = 0; i < unrelated; i++) {
                    work(data, id(100000 + i * 2), id(100001 + i * 2));
                    data.add(CURRENT, id(100000 + i * 2), NAMES.get(2), text("unrelated " + i));
                }
            });
            f.prepare(); Node source = f.token(WORK); String basis = f.basis(WORK);
            Set<Quad> singleton = f.read(() -> singleton(f.data));
            Node snapshot = recipe(f, "population:" + unrelated);
            long probes = 0, rows = 0, utf8 = 0, headerBytes = 0, budgetChecks = 0; int turns = 0, visits = 0, copies = 0;
            for (; turns < 100; turns++) {
                final int step = turns;
                Object[] measured = f.write(() -> {
                    long[] point = {0, 0};
                    var bounded = new DatasetGraphWrapper(f.data) {
                        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
                            if (graph.equals(CURRENT) && subject.equals(Node.ANY)) throw new AssertionError("recipe population scan");
                            boolean sourceRange = graph.equals(CURRENT) && subject.equals(WORK) && NAMES.contains(predicate) && object.equals(Node.ANY);
                            if (sourceRange) return super.find(graph, subject, predicate, object);
                            point[0]++;
                            return org.apache.jena.atlas.iterator.Iter.map(super.find(graph, subject, predicate, object), quad -> { point[1]++; return quad; });
                        }
                        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                            point[0]++; boolean present = super.contains(graph, subject, predicate, object);
                            point[1] += present ? 1 : 0; return present;
                        }
                    };
                    try (var work = new CommandWork()) {
                        PublicNameProjection.RecipeTurn[] result = new PublicNameProjection.RecipeTurn[1];
                        f.append(bounded, observed -> result[0] = PublicNameProjection.advanceWorkNameRecipe(observed, snapshot,
                            uri("urn:recipe:population:" + unrelated + ":" + step), Long.MAX_VALUE));
                        var turn = result[0];
                        assertEquals(turn.sourceValues(), counter(work, "work_name_recipe_source_values"));
                        assertEquals(turn.lookahead(), counter(work, "work_name_recipe_lookahead"));
                        assertEquals(turn.copies(), counter(work, "work_name_recipe_copy_attempts"));
                        assertEquals(turn.additions(), counter(work, "work_name_recipe_additions"));
                        assertEquals(0, counter(work, "work_name_sources_changed"));
                        assertEquals(0, counter(work, "work_name_adoption_bases_changed"));
                        assertEquals(0, counter(work, "work_name_scope_links_visited"));
                        assertTrue(turn.sourceValues() + turn.lookahead() + turn.copies() <= 64);
                        assertEquals(counter(work, "work_name_recipe_source_utf8_bytes") + counter(work, "work_name_recipe_copy_utf8_bytes"),
                            counter(work, "work_name_recipe_admitted_bytes"));
                        assertTrue(counter(work, "work_name_recipe_admitted_bytes") <= PublicNameProjection.WORK_RECIPE_TURN_BYTES);
                        assertTrue(counter(work, "work_name_scope_point_probes") <= 180);
                        assertTrue(counter(work, "work_name_scope_point_rows") <= 180);
                        assertTrue("total point probes exceeded bounded turn: " + point[0], point[0] <= 256);
                        assertTrue("total point rows exceeded bounded turn: " + point[1], point[1] <= 256);
                        assertTrue(counter(work, "work_name_scope_budget_checks") >= turn.sourceValues());
                        return new Object[] {turn, point[0], point[1],
                            counter(work, "work_name_recipe_source_utf8_bytes"), counter(work, "work_name_scope_header_utf8_bytes")
                                + counter(work, "work_name_recipe_header_utf8_bytes"), counter(work, "work_name_scope_budget_checks")};
                    }
                });
                var turn = (PublicNameProjection.RecipeTurn) measured[0];
                probes += (long) measured[1]; rows += (long) measured[2]; utf8 += (long) measured[3]; headerBytes += (long) measured[4];
                budgetChecks += (long) measured[5];
                visits += turn.sourceValues(); copies += turn.copies();
                assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
                assertEquals(singleton, f.read(() -> singleton(f.data)));
                if (turn.complete()) { turns++; break; }
            }
            assertTrue(turns > 2 && turns < 100); assertEquals(567, visits); assertEquals(549, copies);
            assertEquals(expected, recipeLiterals(f, snapshot));
            assertTrue(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
            assertTrue(utf8 > visits); assertTrue(headerBytes > utf8);
            long[] counts = {turns, probes, rows, visits, copies, utf8, headerBytes, budgetChecks};
            if (baseline == null) baseline = counts; else assertArrayEquals("unrelated population changed recipe work", baseline, counts);
            System.out.println("Work recipe unrelated=" + unrelated + " turns=" + turns + " sourceValues=" + visits + " copies=" + copies
                + " pointProbes=" + probes + " pointRows=" + rows + " sourceUtf8=" + utf8 + " headerUtf8=" + headerBytes + " deadlineChecks=" + budgetChecks);
        }
    }

    @Test public void currentRecipeReplayRollbackAndInterruptionKeepNativeProgressExact() {
        try (var f = new Fixture()) {
            f.raw(data -> { for (int i = 0; i < 100; i++) data.add(CURRENT, WORK, NAMES.get(2), text("alias " + i)); }); f.prepare();
            Node snapshot = recipe(f, "replay"); Node source = f.token(WORK); String basis = f.basis(WORK);
            assertEquals(snapshot, recipe(f, "replay"));
            Set<Quad> before = f.read(() -> bookkeeping(f.data));
            f.data.begin(ReadWrite.WRITE);
            try { PublicNameProjection.advanceWorkNameRecipe(f.data, snapshot, uri("urn:recipe:aborted"), Long.MAX_VALUE); f.data.abort(); }
            finally { f.data.end(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data)));
            try {
                assertThrows(CancellationException.class, () -> f.write(() -> {
                    var interrupted = new DatasetGraphWrapper(f.data) {
                        @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                            super.add(graph, subject, predicate, object);
                            if (predicate.equals(PublicNameProjection.WORK_NAME_RECIPE_LITERAL)) Thread.currentThread().interrupt();
                        }
                    };
                    return PublicNameProjection.advanceWorkNameRecipe(interrupted, snapshot, uri("urn:recipe:interrupted"), Long.MAX_VALUE);
                }));
            } finally { Thread.interrupted(); }
            assertEquals(before, f.read(() -> bookkeeping(f.data)));
            assertThrows(CancellationException.class, () -> f.write(() -> PublicNameProjection.advanceWorkNameRecipe(f.data, snapshot,
                uri("urn:recipe:deadline"), System.nanoTime() - 1)));
            var first = recipeTurn(f, snapshot, "urn:recipe:first"); assertFalse(first.complete());
            drainRecipe(f, snapshot); Set<Quad> completed = f.read(() -> bookkeeping(f.data));
            var replay = recipeTurn(f, snapshot, "urn:recipe:first");
            assertTrue(replay.replayed()); assertFalse("replay retains its original EOF result", replay.complete()); assertEquals(0, replay.copies());
            assertEquals(completed, f.read(() -> bookkeeping(f.data)));
            assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
            Node other = recipe(f, "second");
            assertThrows(IllegalStateException.class, () -> recipeTurn(f, other, "urn:recipe:first"));
            assertEquals(101, recipeLiterals(f, snapshot).size());
        }
    }

    @Test public void currentRecipeRefusesAliasHeaderErasureAdoptionRawAndRestartChanges() {
        for (String change : List.of("alias", "header", "erasure", "adoption", "raw", "restart", "epoch", "hold")) try (var f = new Fixture()) {
            f.raw(data -> {
                header(data, WORK, id(600), id(601), payload("Avant"));
                data.add(CURRENT, WORK, p("descriptiveMetadataHead"), id(600));
            }); f.prepare(); Node snapshot = recipe(f, change); drainRecipe(f, snapshot);
            assertTrue(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
            switch (change) {
                case "alias" -> f.nativeWrite(data -> data.add(CURRENT, WORK, NAMES.get(2), text("late alias")));
                case "header" -> f.nativeWrite(data -> replace(data, REVISIONS, id(600), p("metadataState"), text(payload("Après"))));
                case "erasure" -> f.nativeWrite(data -> data.add(REVISIONS, id(600), RDF.type.asNode(), p("ErasedRevision")));
                case "adoption" -> f.nativeWrite(data -> owner(data, 12, WORK, MAIN));
                case "raw" -> f.raw(data -> data.add(CURRENT, WORK, LABEL, text("raw")));
                case "restart" -> { f.write(() -> { PublicNameProjection.workScopeExclusiveStartup(f.data); return null; }); f.prepare(); }
                case "epoch" -> f.raw(data -> replace(data, CONTROL, PRODUCT, p("dataEpoch"), text("new-epoch")));
                case "hold" -> f.nativeWrite(data -> data.add(CONTROL, PRODUCT, p("restoreHold"),
                    NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)));
            }
            assertFalse(change, f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
            assertThrows(change, IllegalStateException.class, () -> recipeTurn(f, snapshot, "urn:recipe:stale"));
            assertThrows(change, IllegalStateException.class, () -> recipe(f, change));
        }
    }
    @Test public void emptyCurrentRecipeRequiresNativeEofAndRefusesUnqualifiedOrForgedProgress() {
        try (var f = new Fixture(false)) {
            assertThrows(IllegalStateException.class, () -> recipe(f, "unadmitted"));
        }
        try (var f = new Fixture()) {
            f.raw(data -> { for (Node predicate : NAMES) data.deleteAny(CURRENT, WORK, predicate, Node.ANY); }); f.prepare();
            Node snapshot = recipe(f, "empty");
            assertFalse(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
            var turn = recipeTurn(f, snapshot, "urn:recipe:empty-eof");
            assertTrue(turn.complete()); assertEquals(0, turn.sourceValues()); assertEquals(0, turn.copies());
            assertTrue(recipeLiterals(f, snapshot).isEmpty());
            Node forged = recipe(f, "unfinished");
            assertFalse(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, forged, Long.MAX_VALUE)));
            f.raw(data -> replace(data, PublicNameProjection.REPAIR, forged, p("recipePhase"), text("7")));
            assertFalse(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, forged, Long.MAX_VALUE)));
            assertThrows(IllegalStateException.class, () -> recipeTurn(f, forged, "urn:recipe:forged"));
        }
    }
    private static long encodedBytes(Node value) {
        return org.apache.jena.riot.out.NodeFmtLib.strNT(value).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }
    private static long[] assertRecipeByteRefusal(Fixture f, Node snapshot, String receipt, boolean unscanned) {
        Set<Quad> before = f.read(() -> bookkeeping(f.data));
        Node source = f.token(WORK); String basis = f.basis(WORK);
        long[] counts = new long[3];
        try (var measured = new CommandWork()) {
            assertThrows(IllegalStateException.class, () -> recipeTurn(f, snapshot, receipt));
            if (unscanned) assertEquals("oversized scalar scanned lexical units", 0,
                counter(measured, "work_name_recipe_lexical_units"));
            assertTrue(counter(measured, "work_name_recipe_admitted_bytes") <= PublicNameProjection.WORK_RECIPE_TURN_BYTES);
            counts[0] = counter(measured, "work_name_recipe_source_values");
            counts[1] = counter(measured, "work_name_recipe_lookahead");
            counts[2] = counter(measured, "work_name_recipe_copy_attempts");
        }
        assertEquals("refused turn committed partial recipe/cursor/receipt", before, f.read(() -> bookkeeping(f.data)));
        assertFalse(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
        assertEquals(source, f.token(WORK)); assertEquals(basis, f.basis(WORK));
        return counts;
    }
    @Test public void oversizedCurrentScalarsRefuseRecipeWithoutLexicalScanOrPrimaryDataRejection() {
        String huge = "x".repeat(8 * 1024 * 1024);
        for (String kind : List.of("label", "alias", "datatype", "language", "iri")) try (var f = new Fixture()) {
            Node value = switch (kind) {
                case "datatype" -> NodeFactory.createLiteralDT("small", org.apache.jena.datatypes.TypeMapper.getInstance()
                    .getSafeTypeByName("urn:recipe:datatype:" + huge));
                case "language" -> NodeFactory.createLiteralLang("small", "en-x-" + huge);
                case "iri" -> uri("urn:recipe:value:" + huge);
                default -> text(huge);
            };
            Node predicate = kind.equals("alias") ? NAMES.get(2) : LABEL;
            f.raw(data -> {
                for (Node name : NAMES) data.deleteAny(CURRENT, WORK, name, Node.ANY);
                data.add(CURRENT, WORK, predicate, value);
            }); f.prepare(); Node snapshot = recipe(f, "oversized:" + kind);
            assertRecipeByteRefusal(f, snapshot, "urn:recipe:oversized:" + kind, true);
            assertTrue("legal primary term was rejected/removed", f.read(() -> f.data.contains(CURRENT, WORK, predicate, value)));
        }
        // A legal bounded header can expand beyond the scalar NT byte budget.
        try (var f = new Fixture()) {
            f.raw(data -> {
                for (Node name : NAMES) data.deleteAny(CURRENT, WORK, name, Node.ANY);
                header(data, WORK, id(600), id(601), payload("\uFFFD".repeat(55000)));
                data.add(CURRENT, WORK, p("descriptiveMetadataHead"), id(600));
            }); f.prepare();
            assertRecipeByteRefusal(f, recipe(f, "escaped-header"), "urn:recipe:escaped-header", false);
        }
        System.out.println("Work recipe oversized scalar=8MiB fields=label/alias/datatype/language/iri headerExpansion=refused formattedBytes=0");
    }
    @Test public void oversizedLookaheadIsChargedAndRefusesAllPartialRecipeState() {
        try (var f = new Fixture()) {
            f.raw(data -> {
                data.deleteAny(CURRENT, WORK, LABEL, Node.ANY);
                for (int index = 0; index < 31; index++) data.add(CURRENT, WORK, LABEL, text("lookahead:" + index));
                data.add(CURRENT, WORK, LABEL, text("x".repeat(8 * 1024 * 1024)));
            }); f.prepare(); Node snapshot = recipe(f, "oversized-lookahead");
            long[] counts = assertRecipeByteRefusal(f, snapshot, "urn:recipe:oversized-lookahead", true);
            assertEquals(31, counts[0]); assertEquals(1, counts[1]); assertEquals(0, counts[2]);
            System.out.println("Work recipe oversized lookahead=1 sourceValues=31 copies=0 rollback=exact");
        }
    }
    @Test public void cumulativeRecipeBytesAdmitExactBoundaryAndRefuseOverflowAtomically() {
        for (int extra : List.of(0, 1)) try (var f = new Fixture()) {
            int characters = PublicNameProjection.WORK_RECIPE_TURN_BYTES / 4 - 2;
            Node first = text("a".repeat(characters)), second = text("b".repeat(characters + extra));
            f.raw(data -> {
                for (Node name : NAMES) data.deleteAny(CURRENT, WORK, name, Node.ANY);
                data.add(CURRENT, WORK, LABEL, first);
                data.add(CURRENT, WORK, NAMES.get(1), second);
            }); f.prepare(); Node snapshot = recipe(f, "byte-boundary:" + extra);
            if (extra == 0) {
                try (var measured = new CommandWork()) {
                    var turn = recipeTurn(f, snapshot, "urn:recipe:byte-boundary");
                    assertTrue(turn.complete()); assertEquals(2, turn.sourceValues()); assertEquals(2, turn.copies());
                    assertEquals(PublicNameProjection.WORK_RECIPE_TURN_BYTES / 2,
                        counter(measured, "work_name_recipe_source_utf8_bytes"));
                    assertEquals(PublicNameProjection.WORK_RECIPE_TURN_BYTES / 2,
                        counter(measured, "work_name_recipe_copy_utf8_bytes"));
                    assertEquals(PublicNameProjection.WORK_RECIPE_TURN_BYTES,
                        counter(measured, "work_name_recipe_admitted_bytes"));
                    assertEquals(Set.of(first, second), recipeLiterals(f, snapshot));
                }
                try (var measured = new CommandWork()) {
                    assertTrue(recipeTurn(f, snapshot, "urn:recipe:byte-boundary").replayed());
                    assertEquals(0, counter(measured, "work_name_recipe_admitted_bytes"));
                    assertEquals(0, counter(measured, "work_name_recipe_lexical_units"));
                }
            } else {
                long[] partialCopies = {0};
                DatasetGraph observed = new DatasetGraphWrapper(f.data) {
                    @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                        if (graph.equals(PublicNameProjection.REPAIR) && predicate.equals(PublicNameProjection.WORK_NAME_RECIPE_LITERAL)) partialCopies[0]++;
                        super.add(graph, subject, predicate, object);
                    }
                };
                Set<Quad> before = f.read(() -> bookkeeping(f.data));
                assertThrows(IllegalStateException.class, () -> f.write(() -> PublicNameProjection.advanceWorkNameRecipe(observed,
                    snapshot, uri("urn:recipe:byte-overflow"), Long.MAX_VALUE)));
                assertEquals("test did not cross a partial copy before refusal", 1, partialCopies[0]);
                assertEquals(before, f.read(() -> bookkeeping(f.data)));
                assertRecipeByteRefusal(f, snapshot, "urn:recipe:byte-overflow", false);
            }
        }
        System.out.println("Work recipe byteBoundary source=262144 copies=262144 total=524288 overflow=524290 rollback=exact replayBytes=0");
    }
    @Test public void recipeEncodingAccountsLiteralLanguageDatatypeIriAndLookaheadExactly() {
        try (var f = new Fixture()) {
            var edges = new ArrayList<Node>();
            edges.add(text("\\\"\t\n\r\f\b\u0013\u0014\u007f\uFFFD\uD83D\uDE00\uD800"));
            edges.add(NodeFactory.createLiteralLang("français 日本語 \uFFFD", "fr-CA"));
            edges.add(NodeFactory.createLiteralDirLang("direction é\"", "ar", org.apache.jena.graph.TextDirection.RTL));
            edges.add(NodeFactory.createLiteralDT("typed\\\"\uFFFD", org.apache.jena.datatypes.TypeMapper.getInstance()
                .getSafeTypeByName("urn:recipe:datatype: \\\"<>^`{|}\u0013\u0014\u007fé\uD83D\uDE00")));
            edges.add(uri("urn:recipe:iri: \\\"<>^`{|}\u0013\u0014\u007fé\uD83D\uDE00"));
            edges.add(NodeFactory.createBlankNode("aXZ-_é日"));
            for (int index = 0; index < 35; index++) edges.add(text("byte-edge:" + index));
            f.raw(data -> {
                data.deleteAny(CURRENT, WORK, LABEL, Node.ANY);
                for (Node value : edges) data.add(CURRENT, WORK, LABEL, value);
            }); f.prepare(); Node snapshot = recipe(f, "encoding-edges");
            // Independent formatter oracle over terms actually decoded by TDB.
            List<Node> physical = f.read(() -> {
                var rows = f.data.find(CURRENT, WORK, LABEL, Node.ANY);
                try { var values = new ArrayList<Node>(); rows.forEachRemaining(quad -> values.add(quad.getObject())); return values; }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            });
            int offset = 0; long totalSource = 0, totalCopy = 0;
            for (int step = 0; step < 10; step++) try (var measured = new CommandWork()) {
                var turn = recipeTurn(f, snapshot, "urn:recipe:encoding-edges:" + step);
                long source = 0, copies = 0;
                for (int index = offset; index < offset + turn.sourceValues(); index++) {
                    Node value = physical.get(index); source += encodedBytes(value);
                    if (value.isLiteral()) copies += encodedBytes(value);
                }
                if (turn.lookahead() > 0) source += encodedBytes(physical.get(offset + turn.sourceValues()));
                assertEquals(source, counter(measured, "work_name_recipe_source_utf8_bytes"));
                assertEquals(copies, counter(measured, "work_name_recipe_copy_utf8_bytes"));
                assertEquals(source + copies, counter(measured, "work_name_recipe_admitted_bytes"));
                assertTrue(source + copies <= PublicNameProjection.WORK_RECIPE_TURN_BYTES);
                offset += turn.sourceValues(); totalSource += source; totalCopy += copies;
                if (turn.complete()) break;
            }
            assertEquals(physical.size(), offset);
            assertTrue(f.read(() -> PublicNameProjection.workNameRecipeComplete(f.data, snapshot, Long.MAX_VALUE)));
            assertEquals(new HashSet<>(physical.stream().filter(Node::isLiteral).toList()), recipeLiterals(f, snapshot));
            System.out.println("Work recipe encodingEdges sourceBytes=" + totalSource + " copyBytes=" + totalCopy + " lookahead=charged formatterOracle=exact");
        }
    }

}
