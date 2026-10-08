package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class CreditSeekKeyTest {
    private static final String WORK = "https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    private static final String AUTHOR = "https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    private static final String DIRECTOR = "https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    private static final String UNKNOWN = "https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    private static final String SCHEMA = "https://schema.org/";

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static void add(DatasetGraph data, String subject, Node predicate, Node object) {
        data.add(uri(TemplateIndexService.CURRENT), uri(subject), predicate, object);
    }
    private static DatasetGraph data() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        return data;
    }

    @Test public void rankedKeysWalkAuthorThenDirectorArtistAndStudioBeforeStoredRoles() {
        assertEquals(3, TemplateIndexService.TYPES.indexOf("FixedRelease"));
        assertEquals(4, TemplateIndexService.TYPES.indexOf("NativeAgentCredit"));
        String author = TemplateIndexService.creditSeekKey("author", "0", AUTHOR);
        String laterAuthor = TemplateIndexService.creditSeekKey("author", "2", AUTHOR);
        String sameOrdinal = TemplateIndexService.creditSeekKey("author", "2", DIRECTOR);
        String director = TemplateIndexService.creditSeekKey("director", "0", DIRECTOR);
        String artist = TemplateIndexService.creditSeekKey("artist", "0", AUTHOR);
        String studio = TemplateIndexService.creditSeekKey("animation-studio", "0", AUTHOR);
        String translator = TemplateIndexService.creditSeekKey("translator", "99", AUTHOR);
        String editor = TemplateIndexService.creditSeekKey("editor", "0", AUTHOR);
        assertEquals("0:000:" + AUTHOR, author);
        assertEquals("0:002:" + AUTHOR, laterAuthor);
        assertEquals("1:000:" + DIRECTOR, director);
        assertTrue(author.compareTo(laterAuthor) < 0);
        assertTrue(laterAuthor.compareTo(sameOrdinal) < 0);
        assertTrue(sameOrdinal.compareTo(director) < 0);
        assertTrue(director.compareTo(artist) < 0);
        assertTrue(artist.compareTo(studio) < 0);
        assertTrue(studio.compareTo(translator) < 0);
        assertTrue(translator.compareTo(editor) < 0);
        assertNull(TemplateIndexService.creditSeekKey("cast", "0", AUTHOR));
        assertNull(TemplateIndexService.creditSeekKey("author", "", AUTHOR));
        assertNull(TemplateIndexService.creditSeekKey("author", "1000", AUTHOR));
    }

    @Test public void authorAndNativeCreditsPostTheRankedKeyAndAnUnknownRoleDoesNot() {
        DatasetGraph data = data();
        try {
            add(data, AUTHOR, RDF.type.asNode(), uri(TemplateIndexService.RV + "AuthorCredit"));
            add(data, AUTHOR, uri(TemplateIndexService.RV + "work"), uri(WORK));
            add(data, AUTHOR, uri(SCHEMA + "roleName"), NodeFactory.createLiteralString("author"));
            add(data, AUTHOR, uri(SCHEMA + "position"), NodeFactory.createLiteralString("2"));
            TemplateIndexService.Entity author = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, AUTHOR);
            assertEquals(List.of("0:002:" + AUTHOR), author.terms().get("creditKey"));
            assertEquals(List.of("author"), author.terms().get("roleName"));
            assertEquals(Set.of(new TemplateIndexService.Key(TemplateIndexService.CURRENT, TemplateIndexService.RV + "work",
                WORK, TemplateIndexService.RV + "AuthorCredit")), TemplateIndexService.keys(author));

            add(data, DIRECTOR, RDF.type.asNode(), uri(TemplateIndexService.RV + "NativeAgentCredit"));
            add(data, DIRECTOR, uri(TemplateIndexService.RV + "work"), uri(WORK));
            add(data, DIRECTOR, uri(SCHEMA + "roleName"), NodeFactory.createLiteralString("director"));
            TemplateIndexService.Entity director = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, DIRECTOR);
            assertEquals(List.of("1:000:" + DIRECTOR), director.terms().get("creditKey"));
            assertNull(director.terms().get("ordinal"));
            assertEquals(Set.of(new TemplateIndexService.Key(TemplateIndexService.CURRENT, TemplateIndexService.RV + "work",
                WORK, TemplateIndexService.RV + "NativeAgentCredit")), TemplateIndexService.keys(director));
            assertTrue(author.terms().get("creditKey").get(0).compareTo(director.terms().get("creditKey").get(0)) < 0);

            add(data, UNKNOWN, RDF.type.asNode(), uri(TemplateIndexService.RV + "NativeAgentCredit"));
            add(data, UNKNOWN, uri(TemplateIndexService.RV + "work"), uri(WORK));
            add(data, UNKNOWN, uri(SCHEMA + "roleName"), NodeFactory.createLiteralString("cast"));
            TemplateIndexService.Entity unknown = TemplateIndexService.entity(data, TemplateIndexService.CURRENT, UNKNOWN);
            assertNull(unknown.terms().get("creditKey"));
            assertEquals(List.of("cast"), unknown.terms().get("roleName"));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
