package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Characterizes the boundary a deferred writer must preserve. Authoritative
 * changes are committed separately from directory repair to expose the pending
 * interval; the production writer currently performs both synchronously.
 * These are native owner checks, not public API or writer timing evidence. */
public class AlsoEnjoyedPendingMembershipTest {
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
    private static List<String> live(AlsoEnjoyedCandidatesTest.Fixture fixture, Map<String,Object> page) {
        fixture.data.begin(ReadWrite.READ);
        try {
            @SuppressWarnings("unchecked") List<String> works = (List<String>) page.get("works");
            return works.stream().filter(work -> PublicNameProjection.candidateWork(fixture.data, uri(work))).toList();
        } finally { fixture.data.end(); }
    }
    @Test public void pendingRemovalNeedsALiveFenceBeforeRealmMembershipConverges() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            fixture.slot(100, work, realm);
            fixture.write(() -> protection(fixture.data, work));
            var first = fixture.page(source, List.of(), null, realm, 21);
            assertEquals(List.of(work.getURI()), first.get("works"));
            assertEquals(List.of(), live(fixture, first));
            assertEquals(first, fixture.page(source, List.of(), null, realm, 21));
            fixture.write(() -> AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE));
            assertEquals(List.of(), fixture.page(source, List.of(), null, realm, 21).get("works"));
        }
    }
    @Test public void pendingInsertionCannotBeRecoveredByFilteringExistingRealmLeaves() {
        try (var fixture = new AlsoEnjoyedCandidatesTest.Fixture()) {
            Node source = fixture.work(10, RECIPE, "en"), work = fixture.work(20, RECIPE, "en"), realm = id(900);
            fixture.write(() -> {
                fixture.data.deleteAny(CURRENT, work, p("catalogueVisible"), Node.ANY);
                publication(fixture.data, work, id(23), id(24), id(25));
                selection(fixture.data, work, id(21), id(23), id(24), id(25), id(22));
                AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE);
            });
            fixture.slot(100, work, realm);
            // Publishing a replacement moves the Contribution's authority
            // while Main still selects its old decision. The completed writer
            // removes the Work's Realm leaf during this non-public interval.
            fixture.write(() -> {
                publication(fixture.data, work, id(23), id(26), id(27));
                assertFalse(PublicNameProjection.candidateWork(fixture.data, work));
                AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE);
            });
            // Selecting that newly published decision restores authority. A
            // deferred Realm fan-out has not inserted its leaf yet.
            fixture.write(() -> selection(fixture.data, work, id(21), id(23), id(26), id(27), id(28)));
            fixture.data.begin(ReadWrite.READ);
            try { assertTrue(PublicNameProjection.candidateWork(fixture.data, work)); }
            finally { fixture.data.end(); }
            var first = fixture.page(source, List.of(), null, realm, 21);
            assertEquals(List.of(), first.get("works"));
            assertEquals(List.of(), live(fixture, first));
            assertEquals(first, fixture.page(source, List.of(), null, realm, 21));
            fixture.write(() -> AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE));
            assertEquals(List.of(work.getURI()), fixture.page(source, List.of(), null, realm, 21).get("works"));
        }
    }
    @Test public void evenTheFullCandidateBoundCanBeConsumedByPendingRemovals() {
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
            for (Node work : withdrawn) fixture.write(() -> protection(fixture.data, work));
            var first = fixture.page(source, List.of(), null, realm, AlsoEnjoyedCandidates.PAGE);
            assertEquals(64, ((List<?>) first.get("works")).size());
            assertEquals(List.of(), live(fixture, first));
            assertEquals(first, fixture.page(source, List.of(), null, realm, AlsoEnjoyedCandidates.PAGE));
            // Completion is modeled explicitly; it is not a claimed bounded
            // maintenance page, nor work performed by either read above.
            fixture.write(() -> withdrawn.forEach(work -> AlsoEnjoyedCandidates.refreshWork(fixture.data, work, Long.MAX_VALUE)));
            assertEquals(List.of(survivor.getURI()), fixture.page(source, List.of(), null, realm, 21).get("works"));
        }
    }
}
