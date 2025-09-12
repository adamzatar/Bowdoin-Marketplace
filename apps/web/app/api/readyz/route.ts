// apps/web/app/api/readyz/route.ts
import { logger } from '@bowdoin/observability/logger';
import { getRedisClient } from '@bowdoin/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ReadyCheck = {
  name: string;
  ok: boolean;
  details?: string;
};

export async function GET() {
  const checks: ReadyCheck[] = [];

  // Redis readiness
  try {
    const redis = await getRedisClient();
    const pong = await redis.ping();
    const ok = typeof pong === 'string' && pong.toUpperCase() === 'PONG';
    checks.push({ name: 'redis', ok, details: ok ? 'PONG' : String(pong) });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    checks.push({ name: 'redis', ok: false, details: msg });
    logger.warn({ err: msg }, 'readyz: redis check failed');
  }

  const allOk = checks.every((c) => c.ok);

  // Log once with summary
  logger.info(
    {
      ready: allOk,
      checks: checks.reduce<Record<string, boolean>>((acc, c) => {
        acc[c.name] = c.ok;
        return acc;
      }, {}),
    },
    'readyz probe',
  );

  return new Response(
    JSON.stringify({
      status: allOk ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    }),
    {
      status: allOk ? 200 : 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
      },
    },
  );
}
