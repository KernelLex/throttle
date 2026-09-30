# Elasticsearch

What it does here, how to run it, and how to point the deployed app at a free
hosted cluster.

---

## The design in one line

**Elasticsearch is a derived store. Postgres is the source of truth.**

Everything in the index can be rebuilt with `npm run es:reindex`, and that single
fact drives three others:

1. **The app boots without it.** A search cluster being down must not stop email
   from sending — those are unrelated concerns, and coupling them turns a degraded
   search into a delivery outage.
2. **Search degrades, it does not break.** With no cluster reachable, search falls
   back to a Postgres `ILIKE` query. The response says `backend: "postgres-fallback"`
   and the UI shows a banner, so the user knows results are unranked rather than
   wondering why they got worse.
3. **Indexing is asynchronous.** It runs on its own `search-index` queue, never on
   the SMTP path. A wedged cluster cannot slow down sending.

---

## What is indexed, and when

| Trigger | Job | Why |
|---|---|---|
| Campaign created | one `campaign` job | Makes **scheduled** email searchable immediately |
| Email sent or permanently failed | one `upsert` job | Keeps status and the preview URL current |
| `npm run es:reindex` | bulk, cursor-paginated | Full rebuild from Postgres |

> **Scheduled email is indexed at creation, not at send.** The brief requires both
> sent *and* scheduled email to be searchable, and indexing only on send would
> leave the entire pending backlog invisible — which is the half a user is most
> likely to search for — checking whether an address is already queued.
>
> A campaign of 50,000 recipients enqueues **one** campaign-level job, not 50,000
> single-document jobs.

### The document

Explicit mapping, `dynamic: 'strict'`. With dynamic mapping the first document
containing a numeric-looking string decides that field's type forever, and every
later document that disagrees is rejected — a failure that shows up weeks later as
"some emails just aren't searchable".

`recipientEmail` uses a custom analyser that splits on `@` and `.`, so
`jane.doe@acme.com` is findable by `jane`, `doe` or `acme` — which is how people
actually search a lead list. It is also indexed as a `keyword` for exact filtering.

Weighting: `recipientEmail^3`, `subject^2`, `recipientName^2`, then body and
campaign name. A match in the address or subject is far more useful than one
buried in a long body.

### Tenant isolation

Every query gets a `tenantId` term filter injected **server-side from the session**.
`searchEmailsSchema` in `@throttle/core` has no `tenantId` field at all, so a client
cannot supply one even by trying — the IDOR is impossible by construction rather
than by remembering to check.

---

## Running it locally

### With Docker

```bash
npm run infra:up          # Postgres, Redis and Elasticsearch
npm run es:reindex        # build the index from existing rows
```

### Without Docker

Elasticsearch ships as a self-contained archive with its own bundled JDK, so it
runs on Windows with no Docker and no separate Java install.

1. Download **Elasticsearch 8.x, Windows .zip** from
   <https://www.elastic.co/downloads/elasticsearch>
2. Unzip it, then in `config/elasticsearch.yml` add:

```yaml
# LOCAL DEVELOPMENT ONLY. Disables auth and TLS so the app can connect over
# plain HTTP on localhost. Never do this on anything reachable from a network.
xpack.security.enabled: false
xpack.security.http.ssl.enabled: false
discovery.type: single-node
```

3. Cap the heap so it does not take a gigabyte and a half — create
   `config/jvm.options.d/heap.options`:

```
-Xms512m
-Xmx512m
```

4. Run `bin\elasticsearch.bat`, then in another terminal:

```bash
curl localhost:9200        # should return cluster info
npm run es:reindex -w @throttle/api
```

`.env` already points at `http://localhost:9200`, so nothing else changes.

---

## Hosting it (what is actually free in 2026)

**The deployed app does not have an Elasticsearch cluster.** Search there runs the
documented Postgres fallback, and the dashboard says so rather than silently
returning worse results.

That is a deliberate choice, because the free options all have a catch:

| Option | Cost | Catch |
|---|---|---|
| **Elastic Cloud** | Free **14-day trial**, no card | Genuine Elasticsearch, zero code change — but expires |
| **Aiven OpenSearch** | Free **forever** (1 GB / 1 GB) | Not Elasticsearch, and see the client note below |
| **AWS OpenSearch** | Free 12 months | Needs an AWS account and a card |
| **Bonsai** | **From $15/mo** | No free tier — the Sandbox plan was retired |
| **Local** | Free | Real Elasticsearch, but not reachable from Render |

### Why OpenSearch is not a drop-in

`@elastic/elasticsearch` v8 performs a **product check**: it verifies an
`X-Elastic-Product: Elasticsearch` response header and throws
`ProductNotSupportedError` against anything else. OpenSearch does not send it.

So switching to Aiven means switching to `@opensearch-project/opensearch` too —
about half an hour of work, since that client is a fork of the ES 7 client and the
call shapes are close but not identical.

### To point the deployed app at a cluster

Whichever provider, it is two environment variables on Render:

| Variable | Value |
|---|---|
| `ELASTICSEARCH_URL` | full URL including credentials, e.g. `https://user:pass@host:443` |
| `ELASTICSEARCH_REQUIRED` | `true` once it is genuinely working |

> Leave `ELASTICSEARCH_REQUIRED=false` until the cluster is confirmed. While it is
> `false` a bad URL degrades quietly; set to `true` and `/readyz` fails, which
> takes the service out of rotation.

Then rebuild the index from the Render shell:

```bash
npm run es:reindex -w @throttle/api
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Search works but shows the degraded banner | Cluster unreachable | Check `ELASTICSEARCH_URL`; `curl $ELASTICSEARCH_URL` |
| `es:reindex` says it cannot connect | Elasticsearch is not running, or the URL is wrong | Start it locally (see above), or check `ELASTICSEARCH_URL` includes credentials |
| Reindex finishes but search returns nothing | Index not refreshed | The script forces a refresh; if you indexed by hand, `POST /throttle-emails/_refresh` |
| `strict_dynamic_mapping_exception` | A field was added to `EmailDocument` but not the mapping | Add it to `INDEX_MAPPING`, delete the index, reindex |
| Results missing recently-sent email | Indexing queue backed up | Check `/admin/queues` → `search-index` |

---

## Known gaps

- **Time-based indices** (`throttle-emails-2026-09`) with ILM, so old data rolls to
  cheaper storage and is dropped by policy rather than a `DELETE` query.
- **A reconcile job** comparing Postgres and index counts per campaign, to catch
  silent drift rather than waiting for someone to notice a missing result.
- **Search-as-you-type** on the recipient field, which needs its own mapping.
