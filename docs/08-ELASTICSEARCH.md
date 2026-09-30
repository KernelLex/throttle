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
> likely to search for ("did I already queue this address?").
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

```bash
npm run infra:up          # starts Postgres, Redis and Elasticsearch
npm run es:reindex        # build the index from existing rows
```

Verify:

```bash
curl localhost:4000/readyz          # elasticsearch: "ok"
curl localhost:9200/_cat/indices    # throttle-emails should appear
```

---

## Hosting it free (for the deployed app)

The deployed stack has no Elasticsearch, so search currently runs the Postgres
fallback. To make it real, add a free hosted cluster.

### Bonsai — the recommended option

Free tier: 10,000 documents, 35 MB. Comfortably enough for a demo.

1. <https://bonsai.io> → **Sign up** → **Create Cluster**
2. Plan: **Sandbox (free)**, version **8.x**, region closest to your Render service
   (Singapore, if you followed `DEPLOYMENT.md`)
3. Open the cluster → **Credentials** → copy the **full access URL**, which embeds
   the key and secret:

```
https://ACCESS_KEY:ACCESS_SECRET@your-cluster-1234.ap-southeast-1.bonsaisearch.net:443
```

4. **Render → throttle-api → Environment:**

| Variable | Value |
|---|---|
| `ELASTICSEARCH_URL` | the full URL above, credentials included |
| `ELASTICSEARCH_REQUIRED` | `true` |

> Setting `ELASTICSEARCH_REQUIRED=true` makes `/readyz` fail if the cluster is
> unreachable. Do that only once it is genuinely working — while it is `false`,
> a bad URL degrades quietly instead of taking the service out of rotation.

5. Save (Render redeploys), then build the index from the Render **Shell**:

```bash
npm run es:reindex -w @throttle/api
```

6. Search in the dashboard. The degraded-mode banner should be gone.

### Alternatives

| Option | Free tier | Note |
|---|---|---|
| **Bonsai** | 10k docs, 35 MB, no time limit | Recommended |
| **Elastic Cloud** | 14-day trial | Then paid — fine for a demo week, not beyond |
| **Local Docker** | unlimited | Perfect for the demo video; not reachable from Render |

**If you would rather not host it:** demonstrate Elasticsearch running locally in
the video (`npm run infra:up` gives you a real cluster) and say in the README that
the deployed instance runs the documented Postgres fallback. That is an honest
position — the code path is complete either way.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Search works but shows the degraded banner | Cluster unreachable | Check `ELASTICSEARCH_URL`; `curl $ELASTICSEARCH_URL` |
| `es:reindex` says it cannot connect | Wrong URL, or credentials missing from it | Bonsai's URL must include `key:secret@` |
| Reindex finishes but search returns nothing | Index not refreshed | The script forces a refresh; if you indexed by hand, `POST /throttle-emails/_refresh` |
| `strict_dynamic_mapping_exception` | A field was added to `EmailDocument` but not the mapping | Add it to `INDEX_MAPPING`, delete the index, reindex |
| Results missing recently-sent email | Indexing queue backed up | Check `/admin/queues` → `search-index` |

---

## What I would change with more time

- **Time-based indices** (`throttle-emails-2026-09`) with ILM, so old data rolls to
  cheaper storage and is dropped by policy rather than a `DELETE` query.
- **A reconcile job** comparing Postgres and index counts per campaign, to catch
  silent drift rather than waiting for someone to notice a missing result.
- **Search-as-you-type** on the recipient field, which needs its own mapping.
