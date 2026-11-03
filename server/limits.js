/**
 * 进程内滑动窗口限流（默认用于 AI / STEP 这类重接口）。
 * 多实例部署时每个实例各自计数；需要全局配额时应换成 Redis/共享存储计数。
 */
export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now }) {
  const buckets = new Map();

  const take = (key) => {
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
    }
    const current = now();
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= current) {
      entry = { count: 0, resetAt: current + windowMs };
      buckets.set(key, entry);
    }
    if (entry.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - current) / 1000)),
      };
    }
    entry.count += 1;
    if (buckets.size > 5000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= current) buckets.delete(bucketKey);
      }
    }
    return { allowed: true, remaining: limit - entry.count, retryAfterSec: 0 };
  };

  return { take, size: () => buckets.size };
}
