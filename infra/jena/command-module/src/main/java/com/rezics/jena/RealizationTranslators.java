package com.rezics.jena;

import java.util.HashSet;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.sparql.expr.ExprEvalException;
import org.apache.jena.sparql.expr.NodeValue;
import org.apache.jena.sparql.function.FunctionBase3;

/** Bounded access to an immutable realization revision's native translator property.
 * Older revisions retain their bytes; this needs no backfill or current-head projection. */
public final class RealizationTranslators extends FunctionBase3 {
    private static final String NATIVE = "https://rezics.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    @Override public NodeValue exec(NodeValue state, NodeValue component, NodeValue work) {
        try {
            if (!state.isString() || !component.isIRI() || !work.isIRI()) throw new IllegalArgumentException();
            String raw = state.getString();
            if (raw.length() > 8192) throw new IllegalArgumentException();
            var record = JSON.parse(raw);
            if (!record.get("profile").getAsString().value().equals("realization-v1")
                || !record.get("id").getAsString().value().equals(component.asNode().getURI())
                || !record.get("work").getAsString().value().equals(work.asNode().getURI())) {
                throw new IllegalArgumentException();
            }
            var translators = record.get("translators").getAsArray();
            if (translators.size() > 16) throw new IllegalArgumentException();
            var values = new HashSet<String>();
            for (var item : translators) {
                String value = item.getAsString().value();
                if (!value.matches(NATIVE) || !values.add(value)) throw new IllegalArgumentException();
            }
            return NodeValue.makeString(String.join(" ", values));
        } catch (RuntimeException error) {
            // An invalid/missing property is unknown, including under a none Condition.
            throw new ExprEvalException("Immutable realization translator property is unavailable");
        }
    }
}
