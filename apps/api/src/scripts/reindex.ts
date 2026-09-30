/**
 * Rebuild the Elasticsearch index from Postgres.
 *
 *   npm run es:reindex -w @throttle/api
 *
 * Elasticsearch is a DERIVED store here — Postgres is the source of truth — so
 * the index can always be thrown away and rebuilt. That is what lets the app
 * boot without Elasticsearch and degrade search to a Postgres query instead of
 * failing outright.
 *
 * Run it after: pointing at a new cluster, changing the mapping, or any period
 * where the indexing queue was not draining.
 *
 * Safe to run against a live system: documents are upserted by EmailJob id, so a
 * reindex overwrites rather than duplicating, and concurrent live indexing just
 * writes the same document twice.
 */

import '../loadEnv.js';
import { env } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { ensureIndex, esClient, pingElasticsearch } from '../search/elasticsearch.js';
import { reindexAll } from '../search/indexer.js';

async function main(): Promise<void> {
  console.log(`\nReindexing into ${env.ELASTICSEARCH_URL} (index: ${env.ELASTICSEARCH_INDEX})\n`);

  if (!(await pingElasticsearch())) {
    console.error(
      'Cannot reach Elasticsearch.\n' +
        `  ELASTICSEARCH_URL = ${env.ELASTICSEARCH_URL}\n\n` +
        '  Start it locally with:  npm run infra:up\n' +
        '  Or point ELASTICSEARCH_URL at a hosted cluster (see docs/08-ELASTICSEARCH.md).\n',
    );
    process.exit(1);
  }

  await ensureIndex();

  const total = await prisma.emailJob.count();
  if (total === 0) {
    console.log('No emails to index yet. Schedule a campaign first.\n');
    return;
  }

  console.log(`${total.toLocaleString()} email(s) to index…\n`);

  const started = Date.now();
  let lastPrinted = 0;

  const { indexed, errors } = await reindexAll((done, all) => {
    // Print at most every 5% so a large reindex does not flood the terminal.
    const pct = Math.floor((done / all) * 100);
    if (pct >= lastPrinted + 5 || done === all) {
      lastPrinted = pct;
      console.log(`  ${String(done).padStart(7)}/${all}  ${String(pct).padStart(3)}%`);
    }
  });

  // Documents are only searchable after a refresh. Indexing uses refresh:false
  // for throughput, so force one here — otherwise the script finishes and a
  // search immediately afterwards returns nothing, which looks like failure.
  await esClient.indices.refresh({ index: env.ELASTICSEARCH_INDEX });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s — ${indexed.toLocaleString()} indexed` +
      (errors > 0 ? `, ${errors} failed` : '') +
      '\n',
  );

  if (errors > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('\nReindex failed:', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
