import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HTTP_CONNECTION_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_REQUESTS_PER_SOCKET,
  HTTP_REQUEST_TIMEOUT_MS,
} from '../../src/main.js';
import { type AppHarness, bootHarness } from '../support/app-harness.js';

const DEADLINE_SLACK_MS = 1500;

function socketAddress(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);
  return { host: url.hostname, port: Number(url.port) };
}

async function assertServerClosesSocket(
  baseUrl: string,
  bytes: string,
  deadlineMs: number,
): Promise<number> {
  const { host, port } = socketAddress(baseUrl);
  const startedAt = Date.now();

  return await new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      operation();
    };
    const deadline = setTimeout(() => {
      finish(() => reject(new Error(`server left the socket open past ${deadlineMs}ms`)));
    }, deadlineMs);

    socket.once('connect', () => socket.write(bytes));
    socket.once('close', () => finish(() => resolve(Date.now() - startedAt)));
    socket.once('error', (error) => {
      // A reset is a valid hard close. Other connection failures mean the real
      // listening server was not reached and must fail the regression.
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        finish(() => reject(error));
      }
    });
  });
}

describe('direct-exposure HTTP deadlines (Amendment A4)', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('the real shared adapter carries every frozen finite socket/request bound', () => {
    const fastify = harness.app.getHttpAdapter().getInstance();
    const initialConfig = fastify.initialConfig as typeof fastify.initialConfig & {
      requestTimeout: number;
      maxRequestsPerSocket: number;
    };

    expect(initialConfig.connectionTimeout).toBe(HTTP_CONNECTION_TIMEOUT_MS);
    expect(initialConfig.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(initialConfig.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(initialConfig.maxRequestsPerSocket).toBe(HTTP_MAX_REQUESTS_PER_SOCKET);
    expect(fastify.server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
  });

  it(
    'closes incomplete headers and a partial request body through real net sockets',
    async () => {
      const [headerElapsedMs, bodyElapsedMs] = await Promise.all([
        assertServerClosesSocket(
          harness.baseUrl,
          'GET /api/health HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ',
          HTTP_HEADERS_TIMEOUT_MS + DEADLINE_SLACK_MS,
        ),
        assertServerClosesSocket(
          harness.baseUrl,
          'POST /api/purchase HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            'Content-Length: 100\r\n' +
            'Connection: close\r\n\r\n' +
            '{"userId":"partial-body',
          HTTP_REQUEST_TIMEOUT_MS + DEADLINE_SLACK_MS,
        ),
      ]);

      expect(headerElapsedMs).toBeLessThanOrEqual(HTTP_HEADERS_TIMEOUT_MS + DEADLINE_SLACK_MS);
      expect(bodyElapsedMs).toBeLessThanOrEqual(HTTP_REQUEST_TIMEOUT_MS + DEADLINE_SLACK_MS);
    },
    HTTP_REQUEST_TIMEOUT_MS + DEADLINE_SLACK_MS + 2000,
  );
});
