// mcp.ts — MCP (Model Context Protocol) over Streamable HTTP at /mcp.
// JSON-RPC 2.0, plain JSON responses (no SSE). Implements both eras:
//  - modern 2026-07-28: server/discover (no handshake/session)
//  - legacy 2025-11-25 and earlier: initialize + notifications/initialized
// Tool calls act on the same store as REST/GraphQL.
import { FIXED_ISO, VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpRequest {
  /** Parsed JSON body (already validated as an object by the router). */
  body: unknown;
}

export interface McpResponse {
  status: number;
  body: string | null;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function jsonRpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error }) };
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function getRepoOrNull(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolError(`unknown tool: ${name}`);
  // Missing required argument.
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return toolResult(repoJson(store, existing));
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      if (!repo) return toolError(`repository ${repoName} already exists`);
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      store.invalidateRepo(repo);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((i) => i.kind === 'issue');
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return toolResult(items.map((i) => issueJson(store, repo, i)));
    }
    case 'create_pull_request': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return toolError(`branch ${head} or ${base} does not exist`);
      }
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if (!pull) return toolError('a pull request already exists for these branches');
      store.invalidateRepo(repo);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = Number(args.pull_number);
      const item = repo.items.get(number);
      if (!item || item.kind !== 'pull') return toolError(`pull request #${number} not found`);
      if (item.state === 'closed') {
        return toolResult({ sha: item.mergeCommitSha, merged: item.merged, message: `Pull request #${number} merged` });
      }
      const mergeSha = store.squashMerge(repo, item);
      if (!mergeSha) return toolError('merge conflict');
      return toolResult({ sha: mergeSha, merged: true, message: `Pull request #${number} merged` });
    }
    case 'get_issue': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const number = Number(args.issue_number);
      const item = repo.items.get(number);
      if (!item || item.kind !== 'issue') return toolError(`issue #${number} not found`);
      return toolResult(issueJson(store, repo, item));
    }
    case 'list_pull_requests': {
      const repo = getRepoOrNull(store, args.owner, args.repo);
      if (!repo) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((i) => i.kind === 'pull');
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return toolResult(items.map((p) => pullJson(store, repo, p)));
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  get_repository: 'get_repo',
  list_repositories: 'get_repo',
  create_pr: 'create_pull_request',
  merge_pr: 'merge_pull_request',
};

/** Handle one JSON-RPC request object. */
function handleOne(store: Store, req: unknown): McpResponse {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const obj = req as Record<string, unknown>;
  const id = obj.id ?? null;
  const method = typeof obj.method === 'string' ? obj.method : '';
  const params = (obj.params ?? {}) as Record<string, unknown>;
  const isNotification = obj.id === undefined;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method.startsWith('notifications/')) {
    // Notifications get no response body; 202 empty.
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (method === 'server/discover') {
    return jsonRpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return jsonRpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const canonical = TOOL_ALIASES[name] ?? name;
    // Unknown tool: JSON-RPC method-not-found style error, never HTTP 500.
    if (!TOOLS.some((t) => t.name === canonical)) {
      return jsonRpcError(id, -32602, `unknown tool: ${name}`);
    }
    const result = callTool(store, canonical, args);
    return jsonRpcResult(id, result);
  }

  void isNotification;
  return jsonRpcError(id, -32601, `method not found: ${method}`);
}

/** POST /mcp — body must already be parsed JSON; the router handles the parse error. */
export function handleMcp(store: Store, body: unknown): McpResponse {
  if (Array.isArray(body)) {
    // Batch: answer each in order (the suite does not batch MCP, but be liberal).
    const results = body.map((item) => {
      const r = handleOne(store, item);
      return r.body ? JSON.parse(r.body) : null;
    });
    return { status: 200, body: JSON.stringify(results.filter((r) => r !== null)) };
  }
  return handleOne(store, body);
}

export { FIXED_ISO };
