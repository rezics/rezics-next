package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class AlsoEnjoyedCandidatesTest {
    private static final String BOOK = "https://schema.org/Book", RECIPE = "https://schema.org/Recipe";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(TemplateIndexService.RV + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static void set(DatasetGraph data, Node graph, Node owner, Node property, Node value) {
        data.deleteAny(graph, owner, property, Node.ANY); if (value != null) data.add(graph, owner, property, value);
    }
    static final class Fixture implements AutoCloseable {
        final DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        Fixture() {
            write(() -> {
                data.add(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                assertTrue(AlsoEnjoyedCandidates.prepare(data, Long.MAX_VALUE));
            });
        }
        void write(Runnable action) { data.begin(ReadWrite.WRITE);
            try { action.run(); data.commit(); } finally { data.end(); } }
        Node work(int value, String type, String language) {
            Node work = id(value), main = id(value + 1), selection = id(value + 2);
            write(() -> {
                data.add(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
                data.add(CURRENT, work, RDF.type.asNode(), uri(type));
                data.add(CURRENT, work, p("mainVersion"), main);
                data.add(CURRENT, work, p("catalogueVisible"), NodeFactory.createLiteralByValue(true,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
                data.add(CURRENT, main, RDF.type.asNode(), p("MainVersion")); data.add(CURRENT, main, p("work"), work);
                data.add(CURRENT, main, p("selectionHead"), selection);
                data.add(REVISIONS, selection, p("language"), NodeFactory.createLiteralString(language));
                AlsoEnjoyedCandidates.refreshWork(data, work, Long.MAX_VALUE);
            });
            return work;
        }
        Map<String,Object> page(Node source, List<String> types, String language, Node realm, int limit) {
            data.begin(ReadWrite.READ);
            try (CommandWork counters = new CommandWork()) {
                var page = AlsoEnjoyedCandidates.page(data, source.getURI(), types, language, realm == null ? null : realm.getURI(), limit);
                assertEquals(0, CommandWork.currentCount("current_adds")); assertEquals(0, CommandWork.currentCount("other_adds"));
                assertEquals(0, CommandWork.currentCount("other_deletes"));
                assertEquals(((Number) page.get("examined")).longValue(), CommandWork.currentCount("also_enjoyed_candidate_rows_visited"));
                return page;
            } finally { data.end(); }
        }
        Node slot(int value, Node work, Node realm) {
            Node slot = id(value), selection = id(value + 1), decision = id(value + 2);
            write(() -> {
                data.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
                data.add(CURRENT, slot, p("work"), work); data.add(CURRENT, slot, p("realm"), realm);
                data.add(CURRENT, slot, p("selectionHead"), selection);
                data.add(REVISIONS, selection, RDF.type.asNode(), p("PublicationSelection"));
                data.add(REVISIONS, selection, p("work"), work); data.add(REVISIONS, selection, p("publicationDecision"), decision);
                data.add(REVISIONS, decision, p("disclosure"), p("Public"));
                AlsoEnjoyedCandidates.refreshSlot(data, slot, Long.MAX_VALUE);
            });
            return slot;
        }
        @Override public void close() { data.close(); }
    }
    @Test public void unrelatedGrowthAndPendingChangesDoNotAddReadVisits() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), candidate = fixture.work(20, RECIPE, "en");
            Node realm = id(9000); fixture.slot(100, source, realm); fixture.slot(110, candidate, realm);
            var before = fixture.page(source, List.of(RECIPE), "en", null, 32);
            var realmBefore = fixture.page(source, List.of(), null, realm, 21);
            int created = 0;
            for (int scale : new int[]{8,16,32}) {
                while (created < scale) fixture.work(1000 + 10 * created++, BOOK, "en");
                // Source-change rows are outside this physical owner. Changing
                // unrelated graph source heads must not rebuild during a read.
                fixture.write(() -> set(fixture.data, CURRENT, id(1000), p("head"), id(8000 + scale)));
                var page = fixture.page(source, List.of(RECIPE), "en", null, 32);
                assertEquals(List.of(candidate.getURI()), page.get("works"));
                assertEquals(before.get("examined"), page.get("examined"));
                assertEquals(realmBefore, fixture.page(source, List.of(), null, realm, 21));
            }
        }
    }
    @Test public void lexicalUnionExcludesSourceAndKeepsLanguageAndPageBounds() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(200, RECIPE, "en");
            fixture.work(100, BOOK, "en"); fixture.work(50, RECIPE, "ja");
            for (int index = 0; index < 80; index++) fixture.work(1000 + 10 * index, RECIPE, "en");
            var result = fixture.page(source, List.of(BOOK, RECIPE), "en", null, 32);
            @SuppressWarnings("unchecked") List<String> works = (List<String>) result.get("works");
            assertEquals(32, works.size()); assertEquals(id(100).getURI(), works.getFirst());
            assertFalse(works.contains(source.getURI())); assertFalse(works.contains(id(50).getURI()));
            assertEquals(works.stream().sorted().toList(), works);
            assertTrue(((Number) result.get("examined")).intValue() <= AlsoEnjoyedCandidates.MAX_VISITS);
        }
    }
    @Test public void writerWithdrawalPrunesLeavesInsteadOfLeavingADeadPrefixToScan() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en");
            for (int index = 0; index < 80; index++) fixture.work(1000 + 10 * index, RECIPE, "en");
            fixture.write(() -> { for (int index = 0; index < 64; index++) {
                Node work = id(1000 + 10 * index); set(fixture.data, CURRENT, work, p("protectionHead"), id(10000 + index));
                AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE);
            } });
            var page = fixture.page(source, List.of(RECIPE), "en", null, 32);
            @SuppressWarnings("unchecked") List<String> works = (List<String>) page.get("works");
            assertEquals(16, works.size()); assertEquals(id(1640).getURI(), works.getFirst());
            assertFalse(works.contains(id(1000).getURI()));
        }
    }
    @Test public void realmMembershipRetainsDistinctWorksUntilTheirLastPublicSelectionWithdraws() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            Node first = fixture.slot(100, work, realm), second = fixture.slot(110, work, realm);
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(), null, realm, 21).get("works"));
            fixture.write(() -> {
                set(fixture.data, REVISIONS, id(102), p("disclosure"), p("Private"));
                AlsoEnjoyedCandidates.refreshSlot(fixture.data, first, Long.MAX_VALUE);
            });
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(), null, realm, 21).get("works"));
            fixture.write(() -> {
                set(fixture.data, REVISIONS, id(112), p("disclosure"), p("Private"));
                AlsoEnjoyedCandidates.refreshSlot(fixture.data, second, Long.MAX_VALUE);
            });
            assertEquals(List.of(), fixture.page(source, List.of(), null, realm, 21).get("works"));
        }
    }
    @Test public void oldEpochRefusesWithoutPreparingOrMutatingInTheRead() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en");
            fixture.write(() -> set(fixture.data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"),
                p("dataEpoch"), NodeFactory.createLiteralString("replacement")));
            try { fixture.page(source, List.of(RECIPE), "en", null, 32); fail("read must refuse old qualification"); }
            catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("unprepared")); }
            fixture.write(() -> assertTrue(AlsoEnjoyedCandidates.prepare(fixture.data, Long.MAX_VALUE)));
            assertEquals(List.of(), fixture.page(source, List.of(RECIPE), "en", null, 32).get("works"));
        }
    }
    @Test public void firstPageReflectsWriterTypeLanguageAndContentWithdrawal() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, BOOK, "ja");
            fixture.write(() -> {
                fixture.data.delete(CURRENT, work, RDF.type.asNode(), uri(BOOK));
                fixture.data.add(CURRENT, work, RDF.type.asNode(), uri(RECIPE));
                set(fixture.data, REVISIONS, id(22), p("language"), NodeFactory.createLiteralString("en"));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE);
            });
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(RECIPE), "en", null, 32).get("works"));
            assertEquals(List.of(), fixture.page(source, List.of(BOOK), "ja", null, 32).get("works"));
            Node variant = id(100), publication = id(101), revision = id(102);
            fixture.write(() -> {
                fixture.data.add(CURRENT, variant, p("resource"), work);
                fixture.data.add(CURRENT, variant, p("contentPublicationHead"), publication);
                fixture.data.add(REVISIONS, publication, p("contentRevision"), revision);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(variant), Long.MAX_VALUE);
            });
            fixture.write(() -> {
                fixture.data.add(REVISIONS, revision, RDF.type.asNode(), p("ErasedRevision"));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(revision), Long.MAX_VALUE);
            });
            assertEquals(List.of(), fixture.page(source, List.of(RECIPE), "en", null, 32).get("works"));
        }
    }
    @Test public void foreignMultivaluedRelationsDoNotChangeCandidateAuthority() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), candidate = fixture.work(20, RECIPE, "en"), foreign = id(100);
            var before = fixture.page(source, List.of(RECIPE), "en", null, 32);
            fixture.write(() -> {
                fixture.data.add(CURRENT, foreign, p("resource"), source);
                fixture.data.add(CURRENT, foreign, p("resource"), candidate);
                fixture.data.add(CURRENT, foreign, p("component"), source);
                fixture.data.add(CURRENT, foreign, p("component"), candidate);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(foreign), Long.MAX_VALUE);
            });
            assertEquals(before, fixture.page(source, List.of(RECIPE), "en", null, 32));
        }
    }
    @Test public void restoreHoldRefusesEvenAPreparedEpoch() {
        try (var fixture = new Fixture()) {
            Node source = fixture.work(10, RECIPE, "en");
            fixture.write(() -> fixture.data.add(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"),
                p("restoreHold"), NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)));
            try { fixture.page(source, List.of(RECIPE), "en", null, 32); fail("restore hold must refuse"); }
            catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("unprepared")); }
        }
    }
}
