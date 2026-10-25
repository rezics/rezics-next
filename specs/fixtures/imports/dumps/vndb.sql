-- Synthetic PostgreSQL COPY text; no statement may be executed.
SET client_encoding = 'UTF8';
COPY public.users (id, username) FROM stdin;
u1	PRIVATE_ACCOUNT_SENTINEL
\.
COPY public.vn (description, id, image, olang) FROM stdin;
Public synopsis\tcolumn\nnext\\path 🌙	v1	\N	ja
Literal null marker \\N and terminator \\.	v2		en
\.
COPY public.threads_posts (id, msg) FROM stdin;
1	PRIVATE_USER_POST_SENTINEL
\.
COPY public.unknown_table (id, data) FROM stdin;
1	UNRELATED_TABLE_SENTINEL
\.
