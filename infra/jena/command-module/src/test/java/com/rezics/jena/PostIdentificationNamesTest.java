package com.rezics.jena;

import static org.junit.Assert.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class PostIdentificationNamesTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    @Test public void composedWorkNamesFollowPostPublicationWithoutCopyingText() {
        var data = DatasetGraphFactory.createTxnMem();
        Node current=uri(CommandPolicy.CURRENT), revisions=uri(CommandPolicy.REVISIONS), search=uri(CommandPolicy.PUBLIC_SEARCH);
        Node work=id(1), main=id(2), structure=id(3), generation=id(4), placement=id(5), post=id(6), variant=id(7), publication=id(8), eligibility=id(9), text=id(10);
        Node name=uri(PublicNameProjection.PREFIX + "work:" + work.getURI().substring("https://rezics.com/id/".length()));
        data.begin(ReadWrite.WRITE);
        try {
            data.add(current,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
            data.add(current,work,p("mainVersion"),main);
            data.add(current,work,uri("http://www.w3.org/2000/01/rdf-schema#label"),NodeFactory.createLiteralLang("An independent story", "en"));
            data.add(current,structure,p("structureOf"),main);
            data.add(current,structure,p("structureProfile"),p("BookComposition"));
            data.add(current,structure,p("selectedGeneration"),generation);
            data.add(current,generation,p("generationState"),p("Active"));
            data.add(current,placement,RDF.type.asNode(),p("OccurrencePlacement"));
            data.add(current,placement,p("generation"),generation);
            data.add(current,placement,p("occurrenceRole"),p("ChapterRole"));
            data.add(current,placement,uri("https://schema.org/item"),post);
            data.add(current,post,RDF.type.asNode(),p("Post"));
            data.add(current,post,p("head"),id(11));
            data.add(current,variant,RDF.type.asNode(),p("ContentVariant"));
            data.add(current,variant,p("resource"),post);
            data.add(current,variant,p("contentPublicationHead"),publication);
            data.add(current,variant,p("publicSearchEligibilityHead"),eligibility);
            data.add(revisions,publication,RDF.type.asNode(),p("ContentPublicationDecision"));
            data.add(revisions,publication,p("resource"),post);
            data.add(revisions,publication,p("contentRevision"),text);
            data.add(revisions,eligibility,RDF.type.asNode(),p("ContentSearchEligibilityDecision"));
            data.add(revisions,eligibility,p("publicationDecision"),publication);
            PublicNameProjection.refresh(data,work);
            assertFalse(data.contains(search,name,p("resource"),work));
            data.add(revisions,eligibility,p("disclosure"),p("Public"));
            PublicNameProjection.refresh(data,work);
            assertTrue(data.contains(search,name,p("resource"),work));
            assertFalse(data.contains(current,main,p("selectionHead"),Node.ANY));
            assertFalse(data.contains(current,variant,p("resource"),work));
            data.add(current,post,p("protectionHead"),id(12));
            PublicNameProjection.refresh(data,work);
            assertFalse(data.contains(search,name,p("resource"),work));
            data.deleteAny(current,post,p("protectionHead"),Node.ANY);
            data.add(current,placement,p("removedBy"),id(13));
            PublicNameProjection.refresh(data,work);
            assertFalse(data.contains(search,name,p("resource"),work));
            data.deleteAny(current,placement,p("removedBy"),Node.ANY);
            data.add(revisions,text,RDF.type.asNode(),p("ErasedRevision"));
            PublicNameProjection.refresh(data,work);
            assertFalse(data.contains(search,name,p("resource"),work));
            data.commit();
        } finally { data.end(); data.close(); }
    }
}
