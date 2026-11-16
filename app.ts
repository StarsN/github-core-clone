// app.ts — the forge's HTTP server: routing, auth, JSON plumbing.
// One process, standard library only. All state lives in the in-memory Store.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePackRequest, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN_ENV = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 100 * 1024 * 1024;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = value === null ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${++requestCounter}`,
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  };
  if (value === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(status, headers);
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${++requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  if (TOKEN_ENV !== '') return token === TOKEN_ENV;
  return true; // No token configured locally: any bearer token is accepted.
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      await handle(store, req, res);
    } catch (err) {
      // Never let one bad request kill the server (repo-survives-errors).
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        try {
          res.destroy();
        } catch {
          // ignore
        }
      }
    }
  });
  // Keep-alive friendly; the suite reuses connections heavily (read workload).
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 31_000;
  return server;
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const host = req.headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}`;

  // GET /healthz — no token, always 200.
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs the bearer token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const service = gitMatch[3]!;
    if (service === 'info/refs' && method === 'GET') {
      const serviceParam = url.searchParams.get('service') ?? '';
      const protocol = (req.headers['git-protocol'] ?? '') === 'version=2' ? '2' : '0';
      const out = handleInfoRefs(store, owner, repoName, serviceParam, protocol);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = (req.headers['git-protocol'] ?? '') === 'version=2' ? '2' : '0';
      const out = handleUploadPack(store, owner, repoName, protocol, body);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const out = handleReceivePackRequest(store, owner, repoName, body);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL: POST /api/graphql (single document or a batched array).
  if (pathname === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    let parsed: unknown;
    if (body.length === 0) {
      sendJson(res, 400, { message: 'request body must be a JSON object' });
      return;
    }
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'request body is not valid JSON' });
      return;
    }
    const runOne = (item: unknown): Record<string, unknown> => {
      const obj = (item ?? {}) as Record<string, unknown>;
      const query = typeof obj.query === 'string' ? obj.query : '';
      const variables = (obj.variables ?? {}) as Record<string, unknown>;
      const result = executeGraphQL(store, query, variables);
      const out: Record<string, unknown> = { data: result.data };
      if (result.errors) out.errors = result.errors;
      return out;
    };
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map(runOne));
    } else {
      sendJson(res, 200, runOne(parsed));
    }
    return;
  }

  // MCP: POST /mcp (JSON-RPC 2.0 over Streamable HTTP).
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    if (body.length === 0) {
      // Empty body: JSON-RPC parse error.
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const out = handleMcp(store, parsed);
    if (out.body === null) {
      res.writeHead(out.status, { 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    sendRaw(res, out.status, 'application/json; charset=utf-8', Buffer.from(out.body, 'utf8'));
    return;
  }

  // REST v3: /api/v3/...
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s.length > 0);
    // Percent-decode segments (paths may hold spaces etc.).
    const decoded = segments.map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    let body: unknown = {};
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        if (contentType === 'application/json' || contentType === '') {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'request body is not valid JSON' });
            return;
          }
        } else {
          body = {};
        }
      }
    }
    const out = handleRest(store, {
      method,
      segments: decoded,
      query: url.searchParams,
      body,
      baseUrl,
    });
    const headers: Record<string, string> = {};
    if (out.link) headers.link = out.link;
    if (out.response.body === null) {
      res.writeHead(out.response.status, {
        'x-github-request-id': `req-${++requestCounter}`,
        'x-oauth-scopes': 'repo, read:org',
        ...headers,
      });
      res.end();
      return;
    }
    // The body is already a serialised JSON string; send it as-is (no re-parse).
    sendRaw(res, out.response.status, 'application/json; charset=utf-8', Buffer.from(out.response.body, 'utf8'), {
      'x-oauth-scopes': 'repo, read:org',
      ...headers,
    });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
