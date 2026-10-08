package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Set;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class FirstPublicationIndexTest {
    private static final String WORK = "https://rezics.com/id/11111111-1111-4111-8111-111111111111";
    private static final String STATEMENT = "https://rezics.com/id/11111111-1111-4111-8111-111111111113";
    private static final String SLOT = "https://rezics.com/id/11111111-1111-4111-8111-111111111115";
    private static final String DECISION = "https://rezics.com/id/11111111-1111-4111-8111-111111111116";

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String lexical, org.apache.jena.datatypes.RDFDatatype datatype) {
        return NodeFactory.createLiteralDT(lexical, datatype);
    }
    private static void add(DatasetGraph data, String graph, String subject, Node predicate, Node object) {
        data.add(uri(graph), uri(subject), predicate, object);
    }
    private static void statement(DatasetGraph data, String id, String work, Node object, String state) {
        add(data, TemplateIndexService.CURRENT, id, RDF.type.asNode(), RDF.Statement.asNode());
        add(data, TemplateIndexService.CURRENT, id, RDF.subject.asNode(), uri(work));
        add(data, TemplateIndexService.CURRENT, id, RDF.predicate.asNode(), uri(TemplateIndexService.DATE_PUBLISHED));
        add(data, TemplateIndexService.CURRENT, id, RDF.object.asNode(), object);
        add(data, TemplateIndexService.CURRENT, id, uri(TemplateIndexService.RV + "statementState"), uri(TemplateIndexService.RV + state));
        add(data, TemplateIndexService.CURRENT, id, uri(TemplateIndexService.RV + "head"), uri(id + "-head"));
    }
    private static void decide(DatasetGraph data, String statement, String slot, String decision, String context, String outcome) {
        add(data, TemplateIndexService.CURRENT, slot, RDF.type.asNode(), uri(TemplateIndexService.RV + "DecisionSlot"));
        add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "decisionTarget"), uri(statement));
        add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "targetKind"), uri(TemplateIndexService.RV + "StatementTarget"));
        add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "acceptanceContext"), uri(context));
        add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "decisionHead"), uri(decision));
        add(data, TemplateIndexService.REVISIONS, decision, RDF.type.asNode(), uri(TemplateIndexService.RV + "StatementDecision"));
        add(data, TemplateIndexService.REVISIONS, decision, uri(TemplateIndexService.RV + "component"), uri(slot));
        add(data, TemplateIndexService.REVISIONS, decision, uri(TemplateIndexService.RV + "outcome"), uri(TemplateIndexService.RV + outcome));
    }
    private static DatasetGraph data() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        return data;
    }

    @Test public void calendarYearIgnoresTheZoneAndRejectsInvalidDates() {
        assertEquals(Integer.valueOf(2024), TemplateIndexService.publicationYear(literal("2024-06-01", XSDDatatype.XSDdate)));
        assertEquals(Integer.valueOf(1999), TemplateIndexService.publicationYear(literal("1999-12-31T23:00:00-05:00", XSDDatatype.XSDdateTime)));
        assertEquals(Integer.valueOf(7), TemplateIndexService.publicationYear(literal("0007", XSDDatatype.XSDgYear)));
        assertEquals(Integer.valueOf(2011), TemplateIndexService.publicationYear(literal("2011-01-10T14:45:13.815-05:00", XSDDatatype.XSDdateTime)));
        assertNull(TemplateIndexService.publicationYear(literal("2024-13-01", XSDDatatype.XSDdate)));
        assertNull(TemplateIndexService.publicationYear(literal("2023-02-29", XSDDatatype.XSDdate)));
        assertNull(TemplateIndexService.publicationYear(literal("0000", XSDDatatype.XSDgYear)));
        assertNull(TemplateIndexService.publicationYear(literal("1999Z", XSDDatatype.XSDgYear)));
        assertEquals("7976", TemplateIndexService.invertedPublicationYear(2024));
        assertEquals("0001", TemplateIndexService.invertedPublicationYear(9999));
        assertEquals("9999", TemplateIndexService.invertedPublicationYear(1));
        assertEquals("9993", TemplateIndexService.invertedPublicationYear(7));
    }

    @Test public void acceptedDatePostsOneSentinelAndAChangedOrWithdrawnStatementReplacesIt() {
        DatasetGraph data = data();
        try {
            Node published = literal("2024-06-01", XSDDatatype.XSDdate);
            statement(data, STATEMENT, WORK, published, "Active");
            TemplateIndexService.Entity unaccepted = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, STATEMENT);
            assertEquals(WORK, unaccepted.id());
            assertTrue(unaccepted.terms().get("type").isEmpty());
            assertTrue(TemplateIndexService.keys(unaccepted).isEmpty());
            decide(data, STATEMENT, SLOT, DECISION, "urn:rezics:classification-context:realm", "Accepted");
            assertTrue(TemplateIndexService.entity(data, TemplateIndexService.CURRENT, SLOT).terms().get("type").isEmpty());
            decide(data, STATEMENT, SLOT + "-global", DECISION + "-global", TemplateIndexService.GLOBAL_CONTEXT, "Accepted");
            TemplateIndexService.Entity posted = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, STATEMENT);
            assertEquals(List.of(TemplateIndexService.FIRST_PUBLICATION), posted.terms().get("type"));
            assertEquals(List.of(TemplateIndexService.FIRST_PUBLICATION_ANCHOR), posted.terms().get("work"));
            assertEquals(List.of("7976"), posted.terms().get("yearKey"));
            assertEquals(List.of(STATEMENT), posted.terms().get("statement"));
            assertEquals(Set.of(new TemplateIndexService.Key(TemplateIndexService.CURRENT, TemplateIndexService.RV + "work",
                TemplateIndexService.FIRST_PUBLICATION_ANCHOR, TemplateIndexService.FIRST_PUBLICATION)), TemplateIndexService.keys(posted));
            add(data, TemplateIndexService.CURRENT, WORK, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            TemplateIndexService.Entity fromWork = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, WORK);
            assertEquals(posted, fromWork);
            String sibling = STATEMENT + "-same-year";
            statement(data, sibling, WORK, literal("2024-12-31", XSDDatatype.XSDdate), "Active");
            decide(data, sibling, SLOT + "-same", DECISION + "-same", TemplateIndexService.GLOBAL_CONTEXT, "Accepted");
            TemplateIndexService.Entity collapsed = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, sibling);
            assertEquals(List.of("7976"), collapsed.terms().get("yearKey"));
            assertEquals(List.of(STATEMENT, sibling), collapsed.terms().get("statement"));
            data.delete(uri(TemplateIndexService.CURRENT), uri(STATEMENT), RDF.object.asNode(), published);
            Node moved = literal("2011-01-10T14:45:13.815-05:00", XSDDatatype.XSDdateTime);
            data.add(uri(TemplateIndexService.CURRENT), uri(STATEMENT), RDF.object.asNode(), moved);
            add(data, "urn:rezics:graph:control", "urn:rezics:dataset:product", uri(TemplateIndexService.RV + "dataEpoch"), NodeFactory.createLiteralString("epoch"));
            add(data, "urn:rezics:graph:control", "urn:rezics:dataset:product", uri(TemplateIndexService.RV + "sequence"), NodeFactory.createLiteralString("8"));
            var plan = new CommandPolicy.Plan(null, Set.of(), Set.of(STATEMENT), Set.of(), Set.of(), false, false, false);
            TemplateIndexService.refresh(data, List.of(posted), plan);
            TemplateIndexService.Entity changed = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, STATEMENT);
            assertEquals(List.of("7976", "7989"), changed.terms().get("yearKey"));
            data.delete(uri(TemplateIndexService.CURRENT), uri(STATEMENT), uri(TemplateIndexService.RV + "statementState"), uri(TemplateIndexService.RV + "Active"));
            data.add(uri(TemplateIndexService.CURRENT), uri(STATEMENT), uri(TemplateIndexService.RV + "statementState"), uri(TemplateIndexService.RV + "Withdrawn"));
            data.delete(uri(TemplateIndexService.CURRENT), uri(sibling), uri(TemplateIndexService.RV + "statementState"), uri(TemplateIndexService.RV + "Active"));
            data.add(uri(TemplateIndexService.CURRENT), uri(sibling), uri(TemplateIndexService.RV + "statementState"), uri(TemplateIndexService.RV + "Withdrawn"));
            TemplateIndexService.Entity withdrawn = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, STATEMENT);
            assertEquals(WORK, withdrawn.id());
            assertTrue(withdrawn.terms().get("yearKey").isEmpty());
            assertTrue(TemplateIndexService.keys(withdrawn).isEmpty());
            String slot = "urn:rezics:slot:realm";
            add(data, TemplateIndexService.CURRENT, slot, RDF.type.asNode(), uri(TemplateIndexService.RV + "RealmPublicationSlot"));
            add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "work"), uri(WORK));
            add(data, TemplateIndexService.CURRENT, slot, uri(TemplateIndexService.RV + "realm"), uri("urn:rezics:realm:1"));
            TemplateIndexService.Entity realm = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, slot);
            assertEquals(slot, realm.id());
            assertTrue(realm.terms().get("type").contains(TemplateIndexService.RV + "RealmPublicationSlot"));
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void moreThanSixteenAcceptedPublicationYearsExceedsThePhysicalBound() {
        DatasetGraph data = data();
        try {
            for (int index = 0; index < 17; index++) {
                String statement = "https://rezics.com/id/77777777-7777-4777-8777-" + String.format("%012d", index);
                statement(data, statement, WORK, literal(String.format("%04d-01-01", 2000 + index), XSDDatatype.XSDdate), "Active");
                decide(data, statement, statement + "-slot", statement + "-decision", TemplateIndexService.GLOBAL_CONTEXT, "Accepted");
            }
            add(data, TemplateIndexService.CURRENT, WORK, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            assertThrows(IllegalArgumentException.class, () -> TemplateIndexService.entity(data, TemplateIndexService.CURRENT, WORK));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
