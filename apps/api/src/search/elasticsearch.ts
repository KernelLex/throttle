/**
 * Elasticsearch indexing and search.
 *
 * ELASTICSEARCH IS A DERIVED STORE, NEVER THE SOURCE OF TRUTH
 * -----------------------------------------------------------
 * Every document here can be rebuilt from Postgres (`npm run es:reindex`). That single
 * decision drives three others:
 *
 *   1. The app BOOTS without Elasticsearch. A search cluster being down must not stop
 *      emails from sending — those are unrelated concerns, and coupling them turns a
 *      degraded-search incident into a delivery outage.
 *   2. Search FALLS BACK to a Postgres ILIKE query. Worse ranking, no highlighting,
 *      but the dashboard keeps working and the user sees a "degraded" hint rather
 *      than an error page.
 *   3. Indexing is ASYNCHRONOUS, on its own queue. An ES write must never sit on the
 *      SMTP hot path — a wedged cluster would otherwise stall delivery.
 *
 * TENANT ISOLATION
 * ----------------
 * Every query has a `tenantId` term filter injected SERVER-SIDE from the session.
 * `searchEmailsSchema` in @throttle/core deliberately has no tenantId field, so a
 * client literally cannot supply one — the IDOR is impossible by construction rather
 * than by remembering to check.
 */

import { Client, errors as esErrors } from '@elastic/elasticsearch';
import type { EmailStatus } from '@throttle/core';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('elasticsearch');

export const esClient = new Client({
  node: env.ELASTICSEARCH_URL,
  requestTimeout: 5_000,
  // Bounded retries: search is best-effort, and a long retry chain would hold the
  // request open past any reasonable dashboard response time.
  maxRetries: 2,
});

let indexReady = false;
let lastAvailabilityCheck = 0;
let available = false;
const AVAILABILITY_CACHE_MS = 10_000;

export interface EmailDocument {
  emailJobId: string;
  tenantId: string;
  campaignId: string;
  campaignName: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  body: string;
  status: EmailStatus;
  plannedSenderId: string;
  actualSenderId: string | null;
  senderLabel: string;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  rescheduleCount: number;
  createdAt: string;
}

/**
 * Explicit mapping — dynamic mapping is disabled.
 *
 * With dynamic mapping, the first document that happens to contain a numeric-looking
 * string decides that field's type forever, and every later document that disagrees
 * is rejected. Declaring the mapping up front turns that class of bug into a
 * non-event.
 */
const INDEX_MAPPING = {
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      emailJobId: { type: 'keyword' as const },
      // keyword, not text: always filtered on exactly, never full-text searched.
      tenantId: { type: 'keyword' as const },
      campaignId: { type: 'keyword' as const },
      campaignName: { type: 'text' as const, fields: { raw: { type: 'keyword' as const } } },
      // Both analysed AND keyword: users search "jane@" as text but also filter on
      // the exact address.
      recipientEmail: {
        type: 'text' as const,
        analyzer: 'email_analyzer',
        fields: { raw: { type: 'keyword' as const } },
      },
      recipientName: { type: 'text' as const },
      subject: { type: 'text' as const, fields: { raw: { type: 'keyword' as const } } },
      body: { type: 'text' as const },
      status: { type: 'keyword' as const },
      plannedSenderId: { type: 'keyword' as const },
      actualSenderId: { type: 'keyword' as const },
      senderLabel: { type: 'text' as const, fields: { raw: { type: 'keyword' as const } } },
      scheduledAt: { type: 'date' as const },
      sentAt: { type: 'date' as const },
      failedAt: { type: 'date' as const },
      lastError: { type: 'text' as const },
      rescheduleCount: { type: 'integer' as const },
      createdAt: { type: 'date' as const },
    },
  },
  settings: {
    number_of_shards: 1,
    // 0 replicas because this is single-node local infra; a replica would leave the
    // cluster permanently YELLOW and make the health check misleading.
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        // Splits on @ and . so "jane.doe@acme.com" is findable by "jane", "doe" or
        // "acme" — which is how people actually search a lead list.
        email_analyzer: {
          type: 'custom' as const,
          tokenizer: 'uax_url_email',
          filter: ['lowercase', 'email_parts'],
        },
      },
      filter: {
        email_parts: {
          type: 'word_delimiter_graph' as const,
          preserve_original: true,
          split_on_numerics: false,
        },
      },
    },
  },
};

/** Create the index if absent. Safe to call repeatedly. */
export async function ensureIndex(): Promise<boolean> {
  if (indexReady) return true;

  try {
    const exists = await esClient.indices.exists({ index: env.ELASTICSEARCH_INDEX });

    if (!exists) {
      await esClient.indices.create({
        index: env.ELASTICSEARCH_INDEX,
        ...INDEX_MAPPING,
      });
      log.info({ index: env.ELASTICSEARCH_INDEX }, 'Elasticsearch index created');
    }

    indexReady = true;
    available = true;
    return true;
  } catch (err) {
    if (err instanceof esErrors.ResponseError && err.statusCode === 400) {
      // Another instance created it between our exists check and our create.
      indexReady = true;
      available = true;
      return true;
    }

    log.warn(
      { err: err instanceof Error ? err.message : err },
      'Could not prepare Elasticsearch index — search will use the Postgres fallback',
    );
    available = false;
    return false;
  }
}

/**
 * Is Elasticsearch usable right now?
 *
 * Cached for 10 seconds so a down cluster does not add a failed network round-trip
 * to every single search request.
 */
export async function isAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastAvailabilityCheck < AVAILABILITY_CACHE_MS) return available;

  lastAvailabilityCheck = now;
  try {
    await esClient.ping();
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Index or update one document. Idempotent — the doc id is the EmailJob id. */
export async function indexEmail(doc: EmailDocument): Promise<void> {
  await ensureIndex();
  await esClient.index({
    index: env.ELASTICSEARCH_INDEX,
    id: doc.emailJobId,
    document: doc,
    // Not `refresh: true` — that forces a segment flush per document and collapses
    // indexing throughput. The default ~1s visibility delay is fine for a dashboard.
    refresh: false,
  });
}

/** Bulk index. Used by the reindex script. */
export async function bulkIndexEmails(docs: EmailDocument[]): Promise<{ indexed: number; errors: number }> {
  if (docs.length === 0) return { indexed: 0, errors: 0 };
  await ensureIndex();

  const operations = docs.flatMap((doc) => [
    { index: { _index: env.ELASTICSEARCH_INDEX, _id: doc.emailJobId } },
    doc,
  ]);

  const response = await esClient.bulk({ operations, refresh: false });

  let errors = 0;
  if (response.errors) {
    for (const item of response.items) {
      if (item.index?.error) {
        errors++;
        log.warn({ error: item.index.error }, 'Bulk index item failed');
      }
    }
  }

  return { indexed: docs.length - errors, errors };
}

export async function deleteEmailDocument(emailJobId: string): Promise<void> {
  try {
    await esClient.delete({ index: env.ELASTICSEARCH_INDEX, id: emailJobId });
  } catch (err) {
    // Already gone is success, not failure.
    if (err instanceof esErrors.ResponseError && err.statusCode === 404) return;
    throw err;
  }
}

export interface SearchParams {
  /** Injected from the session — NEVER from the request body. */
  tenantId: string;
  query: string;
  status?: EmailStatus;
  campaignId?: string;
  senderId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface SearchResultItem {
  emailJobId: string;
  score: number | null;
  highlights: Record<string, string[]>;
}

export interface SearchResults {
  items: SearchResultItem[];
  total: number;
  tookMs: number;
}

/**
 * Full-text search, scoped to one tenant.
 *
 * Throws on failure so the caller can fall back to Postgres — swallowing the error
 * and returning an empty result set would be indistinguishable from "no matches",
 * which is a far more confusing failure for the user.
 */
export async function searchEmails(params: SearchParams): Promise<SearchResults> {
  await ensureIndex();

  const filters: Record<string, unknown>[] = [
    // The tenant isolation boundary. Non-negotiable, and always first.
    { term: { tenantId: params.tenantId } },
  ];

  if (params.status) filters.push({ term: { status: params.status } });
  if (params.campaignId) filters.push({ term: { campaignId: params.campaignId } });
  if (params.senderId) {
    // Match either the planned or the actual sender, so filtering by a sender finds
    // sends that were rerouted TO it as well as those planned FOR it.
    filters.push({
      bool: {
        should: [
          { term: { plannedSenderId: params.senderId } },
          { term: { actualSenderId: params.senderId } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (params.from || params.to) {
    const range: Record<string, string> = {};
    if (params.from) range['gte'] = params.from.toISOString();
    if (params.to) range['lte'] = params.to.toISOString();
    filters.push({ range: { scheduledAt: range } });
  }

  const response = await esClient.search<EmailDocument>({
    index: env.ELASTICSEARCH_INDEX,
    from: (params.page - 1) * params.pageSize,
    size: params.pageSize,
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: params.query,
              // Weighted: a match in the recipient address or subject is far more
              // useful than one buried in a long body.
              fields: ['recipientEmail^3', 'subject^2', 'recipientName^2', 'body', 'campaignName'],
              fuzziness: 'AUTO',
              operator: 'and',
            },
          },
        ],
        filter: filters,
      },
    },
    highlight: {
      fields: { subject: {}, body: {}, recipientEmail: {} },
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fragment_size: 150,
    },
    track_total_hits: true,
  });

  const total =
    typeof response.hits.total === 'number'
      ? response.hits.total
      : (response.hits.total?.value ?? 0);

  return {
    items: response.hits.hits.map((hit) => ({
      emailJobId: hit._id!,
      score: hit._score ?? null,
      highlights: (hit.highlight ?? {}) as Record<string, string[]>,
    })),
    total,
    tookMs: response.took,
  };
}

export async function pingElasticsearch(): Promise<boolean> {
  try {
    await esClient.ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeElasticsearch(): Promise<void> {
  await esClient.close();
  log.info('Elasticsearch client closed');
}
