// apps/api/test/support/http.ts  [SLICE E — frozen contract §11.1]
//
// Real-socket HTTP driving. `app.inject()` is FORBIDDEN in `test/integration/**`
// (contract §11.1) — it bypasses the HTTP parser, the connection layer, and `req.ip`
// derivation, which is precisely the layer Phase 2 exists to prove (per-IP rate
// limiting, TRUST_PROXY, real Content-Type/body-size handling). Every request in this
// suite goes out over a real loopback TCP socket via `undici`, using ONE shared
// `Agent` with `connections: 128` so the concurrency spec's 500 parallel requests are
// genuinely parallel sockets, not serialized behind a tiny connection pool.
import { Agent, request as undiciRequest } from 'undici';

export const httpAgent = new Agent({ connections: 128, pipelining: 0 });

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  rawBody: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** JSON-serialized automatically; sets `content-type: application/json` unless overridden. */
  body?: unknown;
  /** Sent verbatim — for malformed-JSON / wrong-content-type / oversized-body specs. */
  rawBody?: string;
  contentType?: string;
}

async function send<T = unknown>(
  method: 'GET' | 'POST',
  url: string,
  options: RequestOptions = {},
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  let payload: string | undefined;

  if (options.rawBody !== undefined) {
    payload = options.rawBody;
    if (options.contentType) headers['content-type'] = options.contentType;
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = options.contentType ?? 'application/json';
  } else if (options.contentType) {
    headers['content-type'] = options.contentType;
  }

  const res = await undiciRequest(url, {
    method,
    headers,
    body: payload,
    dispatcher: httpAgent,
  });

  const rawBody = await res.body.text();
  let parsed: unknown;
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
  }

  return {
    status: res.statusCode,
    headers: res.headers as Record<string, string | string[] | undefined>,
    body: parsed as T,
    rawBody,
  };
}

export function get<T = unknown>(url: string, options?: RequestOptions): Promise<JsonResponse<T>> {
  return send<T>('GET', url, options);
}

export function post<T = unknown>(url: string, options?: RequestOptions): Promise<JsonResponse<T>> {
  return send<T>('POST', url, options);
}

/** Called once, in a top-level `afterAll`, never per-spec — the Agent is shared. */
export async function closeHttpAgent(): Promise<void> {
  await httpAgent.close();
}
