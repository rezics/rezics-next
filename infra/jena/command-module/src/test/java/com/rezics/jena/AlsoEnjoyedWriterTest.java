package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Native owner checks of atomic authority/membership writes and current-edge
 * work. Supported HTTP admission and elapsed headroom belong to whole prove. */
public class AlsoEnjoyedWriterTest {
    private static final String RECIPE = "https://schema.org/Recipe";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(TemplateIndexService.RV + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static void protection(DatasetGraph data, Node work) {
        data.add(CURRENT, work, p("protectionHead"), id(900000));
    }
    private static void publication(DatasetGraph data, Node work, Node contribution, Node decision, Node draft) {
        data.deleteAny(CURRENT, contribution, p("publicationHead"), Node.ANY);
        data.add(CURRENT, contribution, p("work"), work);
        data.add(CURRENT, contribution, p("publicationHead"), decision);
        data.add(REVISIONS, decision, RDF.type.asNode(), p("PublicationDecision"));
        for (String field : List.of("component", "contribution")) data.add(REVISIONS, decision, p(field), contribution);
        data.add(REVISIONS, decision, p("work"), work);
        data.add(REVISIONS, decision, p("selectedDraft"), draft);
        data.add(REVISIONS, decision, p("disclosure"), p("Public"));
        data.add(REVISIONS, draft, RDF.type.asNode(), p("RevisionAnchor"));
        data.add(REVISIONS, draft, p("component"), contribution);
    }
    private static void selection(DatasetGraph data, Node work, Node main, Node contribution,
                                  Node decision, Node draft, Node selected) {
        data.deleteAny(CURRENT, main, p("selectionHead"), Node.ANY);
        data.add(CURRENT, main, p("selectionHead"), selected);
        data.add(REVISIONS, selected, RDF.type.asNode(), p("PublicationSelection"));
        data.add(REVISIONS, selected, p("work"), work);
        data.add(REVISIONS, selected, p("mainVersion"), main);
        data.add(REVISIONS, selected, p("context"), main);
        data.add(REVISIONS, selected, p("contribution"), contribution);
        data.add(REVISIONS, selected, p("publicationDecision"), decision);
        data.add(REVISIONS, selected, p("selectedDraft"), draft);
        data.add(REVISIONS, selected, p("language"), NodeFactory.createLiteralString("en"));
    }
    @Test public void tighteningAuthorityRemovesRealmLeavesBeforeTheFirstRead() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            fixture.slot(100, work, realm);
            fixture.write(() -> {
                protection(fixture.data, work);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE);
            });
            var first = fixture.page(source, List.of(), null, realm, 21);
            assertEquals(List.of(), first.get("works"));
            assertEquals(first, fixture.page(source, List.of(), null, realm, 21));
        }
    }
    @Test public void reselectionInsertsRealmLeavesBeforeTheFirstRead() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            fixture.write(() -> {
                fixture.data.deleteAny(CURRENT, work, p("catalogueVisible"), Node.ANY);
                publication(fixture.data, work, id(23), id(24), id(25));
                selection(fixture.data, work, id(21), id(23), id(24), id(25), id(22));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE);
            });
            fixture.slot(100, work, realm);
            // Publishing a replacement moves the Contribution's authority
            // while Main still selects its old decision. The completed writer
            // removes the Work's Realm leaf during this non-public interval.
            fixture.write(() -> {
                publication(fixture.data, work, id(23), id(26), id(27));
                assertFalse(PublicNameProjection.candidateWork(fixture.data, work));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(id(23)), Long.MAX_VALUE);
            });
            assertEquals(List.of(), fixture.page(source, List.of(), null, realm, 21).get("works"));
            fixture.write(() -> {
                selection(fixture.data, work, id(21), id(23), id(26), id(27), id(28));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(id(21)), Long.MAX_VALUE);
            });
            fixture.data.begin(ReadWrite.READ);
            try { assertTrue(PublicNameProjection.candidateWork(fixture.data, work)); }
            finally { fixture.data.end(); }
            var first = fixture.page(source, List.of(), null, realm, 21);
            assertEquals(List.of(work.getURI()), first.get("works"));
            assertEquals(first, fixture.page(source, List.of(), null, realm, 21));
        }
    }
    @Test public void eachWithdrawalPrunesItsOwnLeavesSoTheFirstPageFindsTheSurvivor() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), realm = id(900);
            List<Node> withdrawn = new ArrayList<>();
            // One cut beyond the existing 64-candidate bound, not a timing or
            // population campaign. A public survivor follows the withdrawn keys.
            for (int index = 0; index < 65; index++) {
                Node work = fixture.work(1000 + index * 10, RECIPE, "en");
                fixture.slot(10000 + index * 10, work, realm); withdrawn.add(work);
            }
            Node survivor = fixture.work(2000, RECIPE, "en");
            fixture.slot(20000, survivor, realm);
            for (Node work : withdrawn) fixture.write(() -> {
                protection(fixture.data, work);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE);
            });
            var first = fixture.page(source, List.of(), null, realm, AlsoEnjoyedCandidates.PAGE);
            assertEquals(List.of(survivor.getURI()), first.get("works"));
            assertEquals(first, fixture.page(source, List.of(), null, realm, AlsoEnjoyedCandidates.PAGE));
        }
    }
    private record Cost(long probes, long rows, long adds, long deletes, long works, long slots) {
        List<Long> values() { return List.of(probes, rows, adds, deletes, works, slots); }
    }
    private static Cost measure(AlsoEnjoyedCandidatesTest.Fixture fixture, Runnable action) {
        List<Cost> result = new ArrayList<>();
        fixture.write(() -> {
            try (CommandWork counters = new CommandWork()) {
                action.run(); result.add(new Cost(CommandWork.currentCount("also_enjoyed_writer_probes"),
                    CommandWork.currentCount("also_enjoyed_writer_rows"), CommandWork.currentCount("also_enjoyed_writer_adds"),
                    CommandWork.currentCount("also_enjoyed_writer_deletes"), CommandWork.currentCount("also_enjoyed_writer_works"),
                    CommandWork.currentCount("also_enjoyed_writer_slots")));
            }
        });
        assertTrue(result.getFirst().probes() > 0); return result.getFirst();
    }
    @Test public void authorityWriteWorkIsLinearInOnlyItsCurrentSlots() {
        List<Cost> cuts = new ArrayList<>();
        for (int size : List.of(1, 8, 32)) try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            fixture.work(10, RECIPE, "en"); Node work = fixture.work(20, RECIPE, "en");
            for (int index = 0; index < size; index++) fixture.slot(1000 + 10 * index, work, id(10000 + index));
            fixture.write(() -> protection(fixture.data, work));
            Cost cost = measure(fixture, () -> AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE));
            assertEquals(1, cost.works()); assertEquals(size, cost.slots()); cuts.add(cost);
            Cost replay = measure(fixture, () -> AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE));
            assertEquals(0, replay.adds()); assertEquals(0, replay.deletes());
            System.out.println("also-enjoyed-writer current-slots=" + size + " cost=" + cost.values());
        }
        // Exact affine work, rather than an output-count or timing assertion.
        for (int field = 0; field < 6; field++)
            assertEquals((cuts.get(1).values().get(field) - cuts.get(0).values().get(field)) * 24,
                (cuts.get(2).values().get(field) - cuts.get(1).values().get(field)) * 7);
    }
    @Test public void supersededSourcesLegacyEdgesAndUnrelatedWorksDoNotEnlargeRefresh() {
        List<Cost> cuts = new ArrayList<>();
        Node state = PublicNameProjection.REPAIR;
        for (int size : List.of(1, 8, 32)) try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            fixture.work(10, RECIPE, "en"); Node work = fixture.work(20, RECIPE, "en");
            for (int index = 0; index < size; index++) {
                Node previous = index == 0 ? id(22) : id(1000 + (index - 1) * 10);
                Node selected = id(1000 + index * 10), decision = id(1001 + index * 10), draft = id(1002 + index * 10);
                fixture.write(() -> {
                    publication(fixture.data, work, id(23), decision, draft);
                    selection(fixture.data, work, id(21), id(23), decision, draft, selected);
                    AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(id(21)), Long.MAX_VALUE);
                    assertFalse(fixture.data.contains(state, previous, p("alsoEnjoyedCurrentOwner"), work));
                    assertFalse(fixture.data.contains(state, work, p("alsoEnjoyedCurrentSource"), previous));
                });
                Node unrelated = fixture.work(3000 + index * 10, "https://schema.org/Book", "ja");
                fixture.write(() -> fixture.data.add(state, id(21), p("alsoEnjoyedWork"), unrelated));
                // Current Contribution links and removed slots must not be
                // mistaken for the Work's current Realm-slot neighbourhood.
                Node removed = fixture.slot(5000 + index * 10, work, id(50000 + index));
                Node contribution = id(7000 + index);
                fixture.write(() -> {
                    fixture.data.deleteAny(CURRENT, removed, Node.ANY, Node.ANY);
                    AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(removed), Long.MAX_VALUE);
                    fixture.data.add(CURRENT, contribution, p("work"), work);
                });
            }
            // Superseded revisions remain retained RDF, but trigger no owner.
            Cost obsolete = measure(fixture, () -> AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(id(22)), Long.MAX_VALUE));
            assertEquals(0, obsolete.works()); assertEquals(0, obsolete.slots());
            Cost cost = measure(fixture, () -> AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(id(21)), Long.MAX_VALUE));
            assertEquals(1, cost.works()); assertEquals(0, cost.slots()); cuts.add(cost);
            System.out.println("also-enjoyed-writer history-and-unrelated=" + size + " cost=" + cost.values());
        }
        assertEquals(cuts.get(0), cuts.get(1)); assertEquals(cuts.get(0), cuts.get(2));
    }
    @Test public void slotEditUsesOnlyTheSlotEvenWhenNameAndValidationNeighboursIncludeItsWork() {
        List<Cost> cuts = new ArrayList<>();
        for (int size : List.of(1, 8, 32)) try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            fixture.work(10, RECIPE, "en"); Node work = fixture.work(20, RECIPE, "en"), slot = id(1000);
            for (int index = 0; index < size; index++) fixture.slot(1000 + 10 * index, work, id(10000 + index));
            fixture.write(() -> {
                fixture.data.deleteAny(REVISIONS, id(1002), p("disclosure"), Node.ANY);
                fixture.data.add(REVISIONS, id(1002), p("disclosure"), p("Private"));
            });
            var added = Set.of(new org.apache.jena.sparql.core.Quad(CURRENT, slot, p("selectionHead"), id(1001)));
            Set<Node> actual = AlsoEnjoyedCandidates.changedSubjects(added, Set.of());
            assertEquals(Set.of(slot), actual);
            var plan = new CommandPolicy.Plan(null, Set.of(), Set.of(slot.getURI(), work.getURI()), Set.of(), Set.of(), false, false, true);
            Cost cost = measure(fixture, () -> PublicNameProjection.refresh(fixture.data, plan, "urn:receipt:slot-edit",
                List.of(), List.of(), Long.MAX_VALUE, actual));
            assertEquals(0, cost.works()); assertEquals(1, cost.slots()); cuts.add(cost);
            System.out.println("also-enjoyed-writer slot-edit other-current-slots=" + size + " cost=" + cost.values());
        }
        assertEquals(cuts.get(0), cuts.get(1)); assertEquals(cuts.get(0), cuts.get(2));
    }
    @Test public void abortedAuthorityWriteRestoresLeavesAndCurrentEdges() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            fixture.slot(100, work, realm);
            var before = fixture.page(source, List.of(), null, realm, 21);
            fixture.data.begin(ReadWrite.WRITE);
            try {
                protection(fixture.data, work);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(work), Long.MAX_VALUE);
                fixture.data.abort();
            } finally { fixture.data.end(); }
            assertEquals(before, fixture.page(source, List.of(), null, realm, 21));
        }
    }
    @Test public void legacyPreparationRebuildsCurrentEdgesWithoutReadingLegacyHistory() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en");
            Node preparation = uri(AlsoEnjoyedCandidates.PREFIX + "preparation");
            fixture.write(() -> {
                fixture.data.deleteAny(PublicNameProjection.REPAIR, preparation, p("alsoEnjoyedForm"), Node.ANY);
                fixture.data.deleteAny(PublicNameProjection.REPAIR, preparation, p("alsoEnjoyedBuildForm"), Node.ANY);
                fixture.data.deleteAny(PublicNameProjection.REPAIR, id(21), p("alsoEnjoyedCurrentOwner"), Node.ANY);
                fixture.data.deleteAny(PublicNameProjection.REPAIR, work, p("alsoEnjoyedCurrentSource"), Node.ANY);
                assertFalse(AlsoEnjoyedCandidates.prepared(fixture.data));
                assertFalse(AlsoEnjoyedCandidates.prepare(fixture.data, Long.MAX_VALUE));
                assertTrue(AlsoEnjoyedCandidates.prepare(fixture.data, Long.MAX_VALUE));
                assertTrue(fixture.data.contains(PublicNameProjection.REPAIR, id(21), p("alsoEnjoyedCurrentOwner"), work));
            });
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(RECIPE), "en", null, 32).get("works"));
        }
    }
    @Test public void slotEditsCannotRestoreAnErasedWorkAndReplacementSourcesPruneErasureTriggers() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            // Content variants/revisions use their supported owner URNs, not
            // product UUID identities. Their current edges are still triggers.
            Node variant = uri("urn:rezics:variant:00000000-0000-4000-8000-000000000100"), publication = id(101), revision = uri("urn:rezics:content:revision:00000000-0000-4000-8000-000000000102");
            fixture.write(() -> {
                fixture.data.add(CURRENT, variant, p("resource"), work);
                fixture.data.add(CURRENT, variant, p("contentPublicationHead"), publication);
                fixture.data.add(REVISIONS, publication, p("contentRevision"), revision);
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(variant), Long.MAX_VALUE);
            });
            Node slot = fixture.slot(1000, work, realm);
            fixture.write(() -> {
                fixture.data.add(REVISIONS, revision, RDF.type.asNode(), p("ErasedRevision"));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(revision), Long.MAX_VALUE);
            });
            assertEquals(List.of(), fixture.page(source, List.of(), null, realm, 21).get("works"));
            Cost edit = measure(fixture, () -> AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(slot), Long.MAX_VALUE));
            assertEquals(0, edit.works()); assertEquals(1, edit.slots());
            assertEquals(List.of(), fixture.page(source, List.of(), null, realm, 21).get("works"));
            fixture.write(() -> {
                fixture.data.deleteAny(CURRENT, variant, p("contentPublicationHead"), Node.ANY);
                fixture.data.add(CURRENT, variant, p("contentPublicationHead"), id(201));
                fixture.data.add(REVISIONS, id(201), p("contentRevision"), id(202));
                AlsoEnjoyedCandidates.refresh(fixture.data, Set.of(variant), Long.MAX_VALUE);
                assertFalse(fixture.data.contains(PublicNameProjection.REPAIR, revision, p("alsoEnjoyedCurrentOwner"), work));
            });
            var first = fixture.page(source, List.of(), null, realm, 21);
            assertEquals(List.of(work.getURI()), first.get("works"));
            assertEquals(first, fixture.page(source, List.of(), null, realm, 21));
        }
    }
    @Test public void coldCurrentSlotPreparationRetainsItsPhysicalCursorAcrossTransactions() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            for (int index = 0; index < 75; index++) fixture.slot(1000 + index * 10, work, realm);
            Node state = PublicNameProjection.REPAIR, preparation = uri(AlsoEnjoyedCandidates.PREFIX + "preparation");
            fixture.write(() -> {
                fixture.data.deleteAny(state, preparation, p("alsoEnjoyedForm"), Node.ANY);
                fixture.data.deleteAny(state, preparation, p("alsoEnjoyedBuildForm"), Node.ANY);
                fixture.data.deleteAny(state, work, p("alsoEnjoyedCurrentSlot"), Node.ANY);
                for (int index = 0; index < 75; index++) fixture.data.deleteAny(state, id(1000 + index * 10), p("alsoEnjoyedSlotWork"), Node.ANY);
            });
            for (int expected : List.of(64, 11)) fixture.write(() -> {
                try (CommandWork counters = new CommandWork()) {
                    assertFalse(AlsoEnjoyedCandidates.prepare(fixture.data, Long.MAX_VALUE));
                    assertEquals(expected, CommandWork.currentCount("also_enjoyed_source_rows_visited"));
                    assertEquals(expected, CommandWork.currentCount("also_enjoyed_writer_slots"));
                    assertEquals(0, CommandWork.currentCount("also_enjoyed_writer_works"));
                }
            });
            try { fixture.page(source, List.of(), null, realm, 21); fail("cold qualification must remain refused"); }
            catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("unprepared")); }
            fixture.write(() -> assertTrue(AlsoEnjoyedCandidates.prepare(fixture.data, Long.MAX_VALUE)));
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(), null, realm, 21).get("works"));
        }
    }
}
