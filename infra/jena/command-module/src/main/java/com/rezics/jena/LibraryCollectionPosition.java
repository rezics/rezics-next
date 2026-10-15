package com.rezics.jena;

import java.util.LinkedHashSet;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;

/** A curator's export fence follows the bounded primary mutation. Reading it
 * never hashes every collection or membership in that person's library. The
 * native transaction owns both the collection change and this position. */
final class LibraryCollectionPosition {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), CONTROL = uri(CommandPolicy.CONTROL);

    static Set<Node> curators(DatasetGraph data, Set<Quad> additions, Set<Quad> removals) {
        Set<Node> subjects = new LinkedHashSet<>(), curators = new LinkedHashSet<>();
        for (var delta : java.util.List.of(additions, removals)) for (Quad quad : delta) {
            if (!quad.getGraph().equals(CURRENT)) continue;
            subjects.add(quad.getSubject());
            // Preserve departing owners even when the collection is removed.
            if (quad.getPredicate().equals(p("curator"))) curators.add(quad.getObject());
            if (quad.getPredicate().equals(p("structureOf"))) subjects.add(quad.getObject());
        }
        for (Node subject : Set.copyOf(subjects)) {
            var owners = data.find(CURRENT, subject, p("structureOf"), Node.ANY);
            try { while (owners.hasNext()) subjects.add(owners.next().getObject()); }
            finally { Iter.close(owners); }
        }
        for (Node subject : subjects) {
            var owners = data.find(CURRENT, subject, p("curator"), Node.ANY);
            try { while (owners.hasNext()) curators.add(owners.next().getObject()); }
            finally { Iter.close(owners); }
        }
        return curators;
    }

    static void advance(DatasetGraph data, Set<Node> curators, String receipt) {
        for (Node curator : curators) {
            data.deleteAny(CONTROL, curator, p("libraryCollectionPosition"), Node.ANY);
            data.add(CONTROL, curator, p("libraryCollectionPosition"), uri(receipt));
        }
    }
}
