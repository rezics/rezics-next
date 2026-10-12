| API operation class | Count | Median time (ms) | SQL statements / command (median) | Fuseki calls / command (median) |
| --- | ---: | ---: | ---: | ---: |
| POST /v1/collections | 1 | 2600.7 | 175 | 19 |
| POST /v1/publication-selections | 16 | 2061.0 | 91 | 18 |
| POST /v1/collections/:id/changes | 2 | 1793.1 | 205 | 43.5 |
| POST /v1/works | 17 | 1728.1 | 113 | 12 |
| POST /v1/zones/:id/site-publications | 3 | 1559.7 | 168 | 19 |
| POST /v1/contributions | 16 | 1494.7 | 97 | 14 |
| POST /v1/contribution-publications | 16 | 1488.2 | 106 | 22 |
| POST /v1/compositions/:id/changes | 26 | 1379.0 | 254 | 19 |
| POST /v1/agents | 1 | 1359.5 | 107 | 24 |
| POST /v1/content-drafts | 1 | 1356.7 | 129 | 9 |
| POST /v1/spaces | 1 | 1113.8 | 111 | 11 |
| POST /v1/zones/:id/mounts | 16 | 911.9 | 121 | 18 |
| POST /v1/compositions | 1 | 736.4 | 92 | 9 |
| PUT /v1/works/:id/reader-status | 16 | 241.8 | 50 | 10 |

The slowest class is POST /v1/collections: median 2600.7 ms, 175 SQL statements and 19 Fuseki calls per command. These existing request/work-profile meters were captured while building the retained 16-Work cut in QA `20261011t232050-caef82` (including its fixed setup, 400 Recipe occurrences and 16 of each Launch population). A public Work uses four command classes; their class medians sum to 6.77 seconds, 407 SQL statements and 66 Fuseki calls, explaining the substantial preparation cost without changing an owner path. Raw profiles are retained in `.temp/work-profiles/seed-checkpoints/command-cost-16.json`.
