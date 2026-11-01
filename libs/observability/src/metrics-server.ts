import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from './logger';
import type { RenderFlowMetrics } from './metrics';

/**
 * Minimal Prometheus scrape endpoint for worker processes.
 *
 * Workers are not Nest applications, so they have no HTTP layer to mount a
 * controller on. A bare `node:http` server is deliberate: it adds no framework,
 * no routing and no middleware to a process whose only job is to expose one
 * endpoint. The API already has its own Nest `/metrics` route.
 *
 * The server only serves GET /metrics and GET /health/live. Everything else is
 * 404, so a scrape target cannot accidentally become an open proxy.
 */

export interface MetricsServerOptions {
  port: number;
  metrics: RenderFlowMetrics;
  logger?: Logger;
  /** Defaults to 0.0.0.0 because Prometheus scrapes the container network. */
  host?: string;
}

export interface MetricsServer {
  close(): Promise<void>;
  readonly port: number;
  readonly url: string;
}

export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const host = options.host ?? '0.0.0.0';
  const server: Server = createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? '/';

    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' });
      response.end('method not allowed\n');
      return;
    }

    if (path === '/health/live' || path === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('ok\n');
      return;
    }

    if (path !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found\n');
      return;
    }

    void options.metrics
      .render()
      .then((body) => {
        response.writeHead(200, {
          'Content-Type': options.metrics.contentType,
          'Cache-Control': 'no-store',
        });
        response.end(body);
      })
      .catch((error: unknown) => {
        options.logger?.error({ err: error }, 'metrics render failed');
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('metrics unavailable\n');
      });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, host);
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  options.logger?.info({ metricsUrl: url }, 'metrics server listening');

  // Keep an error handler attached after startup: a later EADDRINUSE or socket
  // error must not become an unhandled 'error' event that kills the worker.
  server.on('error', (error: Error) => {
    options.logger?.error({ err: error, url }, 'metrics server error');
  });

  return {
    port: address.port,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

/**
 * Reads `METRICS_PORT`, failing at boot on a malformed value.
 *
 * A worker silently listening on the wrong port looks healthy and is invisible
 * to Prometheus, which is worse than not starting at all.
 */
export function readMetricsPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`METRICS_PORT must be an integer between 1 and 65535, received "${raw}"`);
  }
  return value;
}
