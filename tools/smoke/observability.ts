/**
 * tools/smoke/observability.ts
 * Minimal runtime check that subpath exports resolve and work.
 */

import { logger } from '@bowdoin/observability/logger';
import { counters } from '@bowdoin/observability/metrics';
import { audit } from '@bowdoin/observability/audit';

async function main() {
  logger.info({ where: 'observability-smoke' }, 'logger works ✅');

  // audit.emit should not throw and should log via pino sink
  await audit.emit('smoke.event', { meta: { hello: 'world' } });

  // counters are safe pre-init (no-ops), and real after initMetrics()
  counters.httpRequests.add(1, { route: '/smoke', method: 'GET' });

  console.log('✅ observability scratch ran without throwing');
}

main().catch((err) => {
  console.error('❌ observability scratch failed', err);
  process.exit(1);
});
