export interface RateLimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
  utilization: string;
  retryAfterMs?: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  limit: number;
}

export class OutboundRateLimiter {
  private static buckets: Map<string, BucketState> = new Map();

  private static getLimit(gateway: string): number {
    switch (gateway.toLowerCase()) {
      case 'razorpay':
        return 200;
      case 'stripe':
        return 100;
      case 'payu':
        return 150;
      case 'upi':
        return 100;
      default:
        return 100;
    }
  }

  private static getBucket(gateway: string): BucketState {
    const key = gateway.toLowerCase();
    let bucket = this.buckets.get(key);
    const limit = this.getLimit(key);
    const now = Date.now();

    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now, limit };
      this.buckets.set(key, bucket);
    } else {
      // Refill tokens based on elapsed time (rate: limit tokens per second)
      const elapsedSeconds = (now - bucket.lastRefill) / 1000;
      if (elapsedSeconds > 0) {
        const addedTokens = elapsedSeconds * limit;
        bucket.tokens = Math.min(limit, bucket.tokens + addedTokens);
        bucket.lastRefill = now;
      }
    }
    return bucket;
  }

  static checkLimit(gateway: string): RateLimitStatus {
    const bucket = this.getBucket(gateway);
    const allowed = bucket.tokens >= 1;
    const remaining = Math.max(0, Math.floor(bucket.tokens));
    const used = bucket.limit - remaining;

    return {
      allowed,
      limit: bucket.limit,
      remaining,
      utilization: `${used}/${bucket.limit} req/sec`,
      retryAfterMs: allowed ? undefined : Math.ceil(((1 - bucket.tokens) / bucket.limit) * 1000)
    };
  }

  static consume(gateway: string): boolean {
    const bucket = this.getBucket(gateway);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  static getUtilization(gateway: string): { limit: number; current: number; text: string } {
    const bucket = this.getBucket(gateway);
    const remaining = Math.max(0, Math.floor(bucket.tokens));
    const current = bucket.limit - remaining;
    return {
      limit: bucket.limit,
      current,
      text: `${current}/${bucket.limit} req/sec`
    };
  }

  static reset(gateway?: string): void {
    if (gateway) {
      this.buckets.delete(gateway.toLowerCase());
    } else {
      this.buckets.clear();
    }
  }
}

