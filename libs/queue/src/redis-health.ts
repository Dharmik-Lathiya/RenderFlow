import Redis from 'ioredis';

import { connectionOptionsFor } from './queue-factory';

/**
 * A minimal Redis connection whose only job is answering `PING`.
 *
 * Readiness must not reuse a BullMQ queue's connection directly: a queue created
 * at boot opens a socket even in test and CLI processes that have no Redis, and
 * `Queue` deliberately hides its raw client behind an interface that does not
 * declare `PING`. This keeps the connection lazy (nothing is dialled until the
 * first probe), fail-fast (no offline queue, no reconnect storm) and closable.
 */
export interface RedisPingProbeOptions {
  redisUrl: string;
  /** Also the TCP connect budget, so a dead host cannot outlive the probe. */
  connectTimeoutMs: number;
}

export interface RedisPingProbe {
  /** True only for a real `PONG` reply. */
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

export function createRedisPingProbe(options: RedisPingProbeOptions): RedisPingProbe {
  const { tls, ...connection } = connectionOptionsFor({ redisUrl: options.redisUrl });
  const client = new Redis({
    ...connection,
    // BullMQ models TLS as a boolean; ioredis wants the TLS options object.
    ...(tls ? { tls: {} } : {}),
    lazyConnect: true,
    // A probe should report an outage now, not queue the PING until Redis is
    // back. Reconnection is the next probe's job.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: options.connectTimeoutMs,
    retryStrategy: () => null,
  });

  // ioredis treats an unhandled `error` event as fatal. A refused connection is
  // an expected, reportable outcome here, not a process-level failure.
  client.on('error', () => undefined);

  return {
    async ping(): Promise<boolean> {
      if (client.status === 'wait' || client.status === 'end') {
        await client.connect();
      }

      return (await client.ping()) === 'PONG';
    },

    async close(): Promise<void> {
      if (client.status === 'wait' || client.status === 'end') {
        client.disconnect();
        return;
      }

      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
