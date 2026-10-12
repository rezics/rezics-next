import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFParser;

/** Evaluate authored queries on independent in-memory datasets using the
 * product's pinned Jena class path. No owner response rows are fabricated. */
public class QueryDataset {
    public static void main(String[] args) throws Exception {
        var cases = JSON.parseAny(Files.readString(Path.of(args[0]))).getAsArray();
        var results = new ArrayList<String>();
        for (var value : cases) {
            JsonObject fixture = value.getAsObject();
            var dataset = DatasetFactory.createTxnMem();
            try {
                dataset.begin(ReadWrite.WRITE);
                try {
                    RDFParser.fromString(fixture.get("dataset").getAsString().value(), Lang.TRIG).parse(dataset);
                    dataset.commit();
                } finally { dataset.end(); }
                dataset.begin(ReadWrite.READ);
                try (var execution = QueryExecutionFactory.create(
                        QueryFactory.create(fixture.get("query").getAsString().value()), dataset)) {
                    var output = new ByteArrayOutputStream();
                    ResultSetFormatter.outputAsJSON(output, execution.execSelect());
                    results.add(output.toString(java.nio.charset.StandardCharsets.UTF_8));
                } finally { dataset.end(); }
            } finally { dataset.close(); }
        }
        System.out.println("[" + String.join(",", results) + "]");
    }
}
