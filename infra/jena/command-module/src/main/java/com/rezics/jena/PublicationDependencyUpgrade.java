package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;

/** Add the owner-neutral index to retained publication links before HTTP admission.
 * Schema.org links remain Recipe's semantic projection; immutable manifests and
 * dependency identities are untouched. Indexed predicate scan, constant memory,
 * one startup transaction; the marker makes subsequent startups a single probe.
 */
final class PublicationDependencyUpgrade {
    private static final Node GRAPH = uri(CommandPolicy.REVISIONS);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node MARKER = uri("urn:rezics:upgrade:publication-dependency-v1");
    private static final Node COMPLETE = uri("https://rezics.com/vocab/upgradeComplete");
    private static final Node TYPE = uri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    private static final Node LEGACY = uri("https://schema.org/recipeInstructions");
    private static final Node DEPENDENCY = uri("https://rezics.com/vocab/publicationDependency");
    private static Node uri(String value) { return NodeFactory.createURI(value); }

    static void apply(DatasetGraph data) {
        if (data.contains(CONTROL, MARKER, COMPLETE, MARKER)) return;
        var links = data.find(GRAPH, Node.ANY, LEGACY, Node.ANY);
        try {
            while (links.hasNext()) {
                var link = links.next();
                if (data.contains(GRAPH, link.getSubject(), TYPE, uri("https://rezics.com/vocab/WorkStructurePublicSource"))
                    && data.contains(GRAPH, link.getObject(), TYPE, uri("http://www.w3.org/ns/oa#SpecificResource")))
                    data.add(new Quad(GRAPH, link.getSubject(), DEPENDENCY, link.getObject()));
            }
        } finally { org.apache.jena.atlas.iterator.Iter.close(links); }
        data.add(new Quad(CONTROL, MARKER, COMPLETE, MARKER));
    }
}
