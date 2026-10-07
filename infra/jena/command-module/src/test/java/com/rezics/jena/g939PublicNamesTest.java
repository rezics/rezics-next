package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class g939PublicNamesTest {
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    static final Node CURRENT=uri(CommandPolicy.CURRENT), PUBLIC=uri(CommandPolicy.PUBLIC_SEARCH),
        REVISIONS=uri(CommandPolicy.REVISIONS), RECEIPTS=uri(CommandPolicy.RECEIPTS);
    static void name(DatasetGraph data, Node resource, String kind) {
        data.add(CURRENT,resource,RDF.type.asNode(),p(kind));
        data.add(CURRENT,resource,uri("http://www.w3.org/2000/01/rdf-schema#label"),NodeFactory.createLiteralLang("Camp Lanterns", "en"));
    }
    static Node nameUnit(Node resource, String kind) { return uri(PublicNameProjection.PREFIX+kind+":"+resource.getURI().substring("https://rezics.com/id/".length())); }
    @Test public void boundedPolicyBatchAdmitsOnlyItsReservedMarkerVariableAndPolicyPredicates() {
        for (String predicate:List.of("nameVisibility","nameVersion","nameListing","listingVersion"))
            assertTrue(PublicNameProjection.nameMaintenanceQuad(new org.apache.jena.sparql.core.Quad(PUBLIC,
                NodeFactory.createVariable("marker"),p(predicate),NodeFactory.createVariable("value"))));
        assertFalse(PublicNameProjection.nameMaintenanceQuad(new org.apache.jena.sparql.core.Quad(PUBLIC,
            NodeFactory.createVariable("unit"),p("nameListing"),NodeFactory.createVariable("value"))));
        assertFalse(PublicNameProjection.nameMaintenanceQuad(new org.apache.jena.sparql.core.Quad(PUBLIC,
            NodeFactory.createVariable("marker"),p("searchBody"),NodeFactory.createVariable("value"))));
    }
    @Test public void javaDisclosureAndListingFollowTheSharedTypeScriptTruthTable() throws Exception {
        var data=DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try (var stream=getClass().getResourceAsStream("/g939-visibility.json")) {
            var cases=JSON.parseAny(new String(stream.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8)).getAsArray();
            for (var value:cases) {
                var row=value.getAsObject(); Node space=id(1);
                data.deleteAny(CURRENT,space,Node.ANY,Node.ANY); name(data,space,"Space");
                data.add(CURRENT,space,p("disclosure"),p(row.get("visibility").getAsString().value().equals("public") ? "Public":"Private"));
                data.add(CURRENT,space,p("listing"),NodeFactory.createLiteralString(row.get("listing").getAsString().value()));
                // Legacy rv:visibility must not override the canonical rv:disclosure.
                data.add(CURRENT,space,p("visibility"),p("Public"));
                PublicNameProjection.refresh(data,space);
                assertEquals(row.get("indexable").getAsBoolean().value(),data.contains(PUBLIC,nameUnit(space,"space"),p("publicTitle"),Node.ANY));
            }
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void capabilityAndAgentNamesDisappearWhenTheirOwningPolicyIsUnlisted() {
        var data=DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node space=id(1),realm=id(2),zone=id(3),agent=id(4);
            name(data,space,"Space"); name(data,realm,"Realm"); name(data,zone,"Zone"); name(data,agent,"Agent");
            data.add(CURRENT,space,p("realmCapability"),realm); data.add(CURRENT,space,p("zoneCapability"),zone);
            data.add(CURRENT,space,p("disclosure"),p("Public")); data.add(CURRENT,space,p("listing"),NodeFactory.createLiteralString("listed"));
            data.add(CURRENT,realm,p("space"),space); data.add(CURRENT,realm,p("realmState"),p("Active"));
            data.add(CURRENT,zone,p("space"),space); data.add(CURRENT,zone,p("zoneState"),p("Active")); data.add(CURRENT,zone,p("disclosure"),p("Public"));
            data.add(CURRENT,agent,p("head"),id(5));
            Node marker=uri(PublicNameProjection.PREFIX+"visibility:"+agent.getURI().substring("https://rezics.com/id/".length()));
            data.add(PUBLIC,marker,p("nameVersion"),NodeFactory.createLiteralString("0"));
            data.add(PUBLIC,marker,p("listingVersion"),NodeFactory.createLiteralString("0"));
            for (Node resource:List.of(realm,zone,agent)) PublicNameProjection.refresh(data,resource);
            assertTrue(data.contains(PUBLIC,nameUnit(realm,"realm"),p("publicTitle"),Node.ANY));
            assertTrue(data.contains(PUBLIC,nameUnit(zone,"site"),p("publicTitle"),Node.ANY));
            assertTrue(data.contains(PUBLIC,nameUnit(agent,"agent"),p("publicTitle"),Node.ANY));
            data.deleteAny(CURRENT,space,p("listing"),Node.ANY); data.add(CURRENT,space,p("listing"),NodeFactory.createLiteralString("unlisted"));
            data.add(PUBLIC,marker,p("nameListing"),NodeFactory.createLiteralString("unlisted"));
            for (Node resource:List.of(realm,zone,agent)) PublicNameProjection.refresh(data,resource);
            for (var pair:List.of(new Object[]{realm,"realm"},new Object[]{zone,"site"},new Object[]{agent,"agent"}))
                assertFalse(data.contains(PUBLIC,nameUnit((Node)pair[0],(String)pair[1]),p("publicTitle"),Node.ANY));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void spacePolicyChangesRestoreItsRealmsConceptNames() {
        var data=DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node space=id(1),realm=id(2),concept=id(3);
            name(data,space,"Space"); name(data,realm,"Realm");
            data.add(CURRENT,space,p("realmCapability"),realm);
            data.add(CURRENT,space,p("disclosure"),p("Public"));
            data.add(CURRENT,realm,p("space"),space); data.add(CURRENT,realm,p("realmState"),p("Active"));
            data.add(CURRENT,concept,RDF.type.asNode(),uri("http://www.w3.org/2004/02/skos/core#Concept"));
            data.add(CURRENT,concept,p("conceptState"),p("Active")); data.add(CURRENT,concept,p("conceptRealm"),realm);
            data.add(CURRENT,concept,uri("http://www.w3.org/2004/02/skos/core#prefLabel"),NodeFactory.createLiteralLang("Realm concept","en"));
            PublicNameProjection.refresh(data,concept);
            var plan=new CommandPolicy.Plan(null,Set.of(),Set.of(space.getURI()),Set.of(),Set.of(),false,false,true);
            int batch=0;
            for (String listing:List.of("listed","unlisted","listed")) {
                data.deleteAny(CURRENT,space,p("listing"),Node.ANY);
                data.add(CURRENT,space,p("listing"),NodeFactory.createLiteralString(listing));
                PublicNameProjection.refresh(data,plan,"urn:receipt:listing:"+(++batch),List.of(),List.of());
                if (listing.equals("unlisted")) assertFalse(PublicNameProjection.visible(data,concept));
                PublicNameProjection.repairBatch(data,"urn:receipt:listing-repair:"+batch);
                assertEquals(listing.equals("listed"),PublicNameProjection.visible(data,concept));
            }
            for (String disclosure:List.of("Private","Public")) {
                data.deleteAny(CURRENT,space,p("disclosure"),Node.ANY); data.add(CURRENT,space,p("disclosure"),p(disclosure));
                PublicNameProjection.refresh(data,plan,"urn:receipt:disclosure:"+disclosure,List.of(),List.of());
                if (disclosure.equals("Private")) assertFalse(PublicNameProjection.visible(data,concept));
                PublicNameProjection.repairBatch(data,"urn:receipt:disclosure-repair:"+disclosure);
                assertEquals(disclosure.equals("Public"),PublicNameProjection.visible(data,concept));
            }
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void moreThan64NamesAreSelectedDeterministicallyAndDeletedUnitsRefreshTheirWork() {
        var data=DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node work=id(1),unit=uri("urn:unit:one");
            name(data,work,"Space"); data.add(CURRENT,work,p("disclosure"),p("Public"));
            for (int i=99;i>=0;i--) data.add(CURRENT,work,uri("http://www.w3.org/2000/01/rdf-schema#label"),NodeFactory.createLiteralLang(String.format("Name %03d",i),"en"));
            PublicNameProjection.refresh(data,work);
            assertEquals(64,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,nameUnit(work,"space"),p("publicTitle"),Node.ANY)));
            assertEquals(64,CatalogueNamePolicy.expected(data,work).size());
            data.deleteAny(CURRENT,work,RDF.type.asNode(),Node.ANY);
            data.add(CURRENT,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
            data.add(CURRENT,work,p("catalogueVisible"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
            data.add(PUBLIC,unit,p("work"),work); data.add(PUBLIC,unit,RDF.type.asNode(),p("MatchUnit"));
            data.add(PUBLIC,unit,p("searchBody"),NodeFactory.createLiteralString("Body"));
            PublicNameProjection.refresh(data,work);
            data.deleteAny(CURRENT,work,p("catalogueVisible"),Node.ANY);
            var capture=new SearchDeltaJournal.Capture(data);
            capture.observed().deleteAny(PUBLIC,unit,Node.ANY,Node.ANY);
            assertEquals(work,capture.changes().getFirst().work());
            var plan=new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true);
            PublicNameProjection.refresh(data,plan,"urn:receipt:delete",List.of(),capture.changes());
            assertFalse(data.contains(PUBLIC,nameUnit(work,"work"),p("publicTitle"),Node.ANY));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void directoryPagesSeekTheirOwnKindAndRawCatalogueSearchExcludesNameUnitsBeforeLimit() {
        var definition=new EntityDefinition("uri","label","graph"); definition.set("publicTitle",p("publicTitle"));
        definition.setLangField("lang"); definition.setUidField("uid");
        var config=new TextIndexConfig(definition); config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(DatasetGraphFactory.createTxnMem(),index,new TextDocProducerTriples(index));
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.CONTROL),uri("urn:rezics:dataset:product"),p("sequence"),NodeFactory.createLiteralString("1"));
            for (int i=1;i<=70;i++) { name(data,id(i),"Space"); data.add(CURRENT,id(i),p("disclosure"),p("Public")); PublicNameProjection.refresh(data,id(i)); }
            data.add(PUBLIC,uri("urn:unit:catalogue"),p("publicTitle"),NodeFactory.createLiteralLang("Camp Lanterns","en")); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            var first=index.directory("space","newest",64,null,data); assertEquals(64,first.hits().size()); assertTrue(first.more());
            var last=first.hits().getLast(); var second=index.directory("space","newest",64,new FilteredGraphTextIndex.RankAfter(last.id(),last.score(),first.commit()),data);
            assertEquals(6,second.hits().size()); assertFalse(second.more());
            assertTrue(index.directory("agent","newest",64,null,data).hits().isEmpty());
            var hits=index.query(p("publicTitle"),"Camp",CommandPolicy.PUBLIC_SEARCH,null,1);
            assertEquals(1,hits.size()); assertEquals("urn:unit:catalogue",hits.getFirst().getNode().getURI());
        } finally { data.end(); data.close(); }
    }
    @Test public void populationContributionReplaysOnceAndWithdrawalErasureAndReleaseTargetsAreExact() {
        var data=DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node observation=id(1),context=id(2),target=id(3),head=id(4),receipt=uri("urn:receipt:rating");
            data.add(CURRENT,observation,p("observationHead"),head); data.add(CURRENT,observation,p("ratingContext"),context);
            data.add(CURRENT,observation,p("targetMainVersion"),target); data.add(CURRENT,observation,p("ratingSlot"),uri("urn:slot:one"));
            data.add(REVISIONS,head,p("component"),observation); data.add(REVISIONS,head,p("ratingAvailability"),p("Available"));
            data.add(REVISIONS,head,p("ratingValue"),NodeFactory.createLiteralString("8"));
            data.add(RECEIPTS,receipt,p("observationRevision"),head); data.add(RECEIPTS,receipt,p("outcome"),p("Succeeded"));
            for (int i=0;i<5;i++) RatingPopulationProjection.refresh(data,observation);
            Node graph=uri(RatingPopulationProjection.GRAPH);
            assertTrue(data.contains(graph,Node.ANY,p("availableRatingCount"),NodeFactory.createLiteralString("1")) ||
              data.find(graph,Node.ANY,p("availableRatingCount"),Node.ANY).next().getObject().getLiteralLexicalForm().equals("1"));
            data.add(REVISIONS,head,RDF.type.asNode(),p("ErasedRevision")); RatingPopulationProjection.refresh(data,observation);
            assertEquals("0",data.find(graph,Node.ANY,p("availableRatingCount"),Node.ANY).next().getObject().getLiteralLexicalForm());
            data.deleteAny(REVISIONS,head,RDF.type.asNode(),p("ErasedRevision")); data.add(CURRENT,observation,p("targetRelease"),id(5));
            RatingPopulationProjection.refresh(data,observation);
            assertTrue(data.contains(graph,Node.ANY,p("populationTarget"),id(5)));
            data.deleteAny(REVISIONS,head,p("ratingAvailability"),Node.ANY); data.add(REVISIONS,head,p("ratingAvailability"),p("Withdrawn"));
            RatingPopulationProjection.refresh(data,observation);
            assertFalse(data.contains(graph,observation,p("countedPopulation"),Node.ANY));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
