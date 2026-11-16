// graphql.ts — a small GraphQL executor for the exact surface the suite exercises:
// viewer, repository (+ issue/issues/pullRequest/pullRequests), node, __type, and the five
// mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment).
// Supports variables, aliases, inline fragments, input objects, enums and batched arrays.
import { parseCommit } from './gitobj.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { pullMergeable } from './rest.ts';

// -------------------------------------------------------------------------------------------
// Lexer / parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: FieldNode[] | null;
}

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selection: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      this.next();
      kind = t.value as 'query' | 'mutation';
      const n = this.peek();
      if (n?.kind === 'name') {
        name = this.next().value;
      }
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const vname = this.next();
        if (vname.kind !== 'name') throw new Error('expected variable name');
        this.expectPunct(':');
        const type = this.parseType();
        variables.push({ name: vname.value, type });
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseType(): string {
    let type = '';
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      const t = this.next();
      if (t.kind !== 'name') throw new Error('expected type name');
      type = t.value;
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(): FieldNode {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '...') {
      this.next();
      const on = this.peek();
      if (on?.kind === 'name' && on.value === 'on') {
        this.next();
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected type condition');
        const selection = this.parseSelectionSet();
        return { alias: null, name: `...on:${typeName.value}`, args: [], selection };
      }
      // Fragment spread (not used by the suite); treat as empty.
      const frag = this.next();
      void frag;
      return { alias: null, name: '...spread', args: [], selection: null };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      const n = this.next();
      if (n.kind !== 'name') throw new Error('expected field name after alias');
      name = n.value;
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const aname = this.next();
        if (aname.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args.push({ name: aname.value, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      const n = this.next();
      if (n.kind !== 'name') throw new Error('expected variable name');
      return { kind: 'variable', name: n.value };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const fname = this.next();
        if (fname.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        fields.push({ name: fname.value, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// -------------------------------------------------------------------------------------------
// Global ids
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts[0];
    if (!kind || parts.length < 2) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Schema knowledge (the field lists __type must report)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'repository', 'comments', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'repository', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name', 'target'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function fieldError(ctx: Ctx, message: string): null {
  ctx.errors.push({ message });
  return null;
}

type AnyRecord = Record<string, unknown>;

function resolveField(ctx: Ctx, typeName: string, source: AnyRecord, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  if (name === '__typename') return (source.__typename as string) ?? typeName;
  const resolver = RESOLVERS[typeName]?.[name];
  if (!resolver) {
    return fieldError(ctx, `Cannot query field "${name}" on type "${typeName}".`);
  }
  return resolver(ctx, source, field, variables);
}

type Resolver = (ctx: Ctx, source: AnyRecord, field: FieldNode, variables: Record<string, unknown>) => unknown;

function repoRecord(store: Store, repo: Repo): AnyRecord {
  return { __typename: 'Repository', __repo: repo, __store: store };
}

function issueRecord(store: Store, repo: Repo, issue: Issue): AnyRecord {
  return { __typename: 'Issue', __repo: repo, __store: store, __issue: issue };
}

function pullRecord(store: Store, repo: Repo, pull: Pull): AnyRecord {
  return { __typename: 'PullRequest', __repo: repo, __store: store, __pull: pull };
}

function repoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id === 'number') {
    for (const repo of store.repos.values()) if (repo.dbId === id) return repo;
    return null;
  }
  if (typeof id !== 'string') return null;
  if (/^\d+$/.test(id)) {
    const dbId = parseInt(id, 10);
    for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
    return null;
  }
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = parseInt(decoded.parts[0] ?? '', 10);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', repo.dbId, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', repo.dbId, pull.number);
}

function resolveNodeId(store: Store, id: unknown): { kind: string; repo: Repo; issue?: Issue; pull?: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const [dbIdStr, numStr] = decoded.parts;
  const dbId = parseInt(dbIdStr ?? '', 10);
  if (!Number.isInteger(dbId)) return null;
  let repo: Repo | undefined;
  for (const r of store.repos.values()) if (r.dbId === dbId) repo = r;
  if (!repo) return null;
  if (decoded.kind === 'Repository') return { kind: 'Repository', repo };
  const number = parseInt(numStr ?? '', 10);
  if (!Number.isInteger(number)) return null;
  const item = repo.items.get(number);
  if (!item) return null;
  if (decoded.kind === 'Issue' && item.kind === 'issue') return { kind: 'Issue', repo, issue: item };
  if (decoded.kind === 'PullRequest' && item.kind === 'pull') return { kind: 'PullRequest', repo, pull: item };
  if (decoded.kind === 'IssueComment' && item.kind === 'issue') {
    return { kind: 'IssueComment', repo, issue: item };
  }
  return null;
}

function issueConnection(
  ctx: Ctx,
  repo: Repo,
  field: FieldNode,
  variables: Record<string, unknown>,
): AnyRecord {
  const first = (argValue(field, 'first', variables) as number | undefined) ?? 10;
  const after = argValue(field, 'after', variables) as string | undefined;
  const states = argValue(field, 'states', variables) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
  let items = [...repo.items.values()].filter((i) => i.kind === 'issue') as Issue[];
  if (states && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  let start = 0;
  if (after) {
    try {
      const cursorText = Buffer.from(after, 'base64').toString('utf8');
      const cursorNum = parseInt(cursorText.replace(/^cursor:/, ''), 10);
      if (Number.isInteger(cursorNum)) {
        const idx = items.findIndex((i) => i.number === cursorNum);
        if (idx >= 0) start = idx + 1;
      }
    } catch {
      // Invalid cursor: start from the beginning.
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const endCursor = page.length ? Buffer.from(`cursor:${page[page.length - 1]!.number}`, 'utf8').toString('base64') : null;
  const nodes = page.map((issue) => issueRecord(ctx.store, repo, issue));
  return {
    __typename: 'IssueConnection',
    __nodes: nodes,
    __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function pullConnection(
  ctx: Ctx,
  repo: Repo,
  field: FieldNode,
  variables: Record<string, unknown>,
): AnyRecord {
  const first = (argValue(field, 'first', variables) as number | undefined) ?? 10;
  const states = argValue(field, 'states', variables) as string[] | undefined;
  let items = [...repo.items.values()].filter((i) => i.kind === 'pull') as Pull[];
  if (states && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((p) => wanted.has(p.state === 'closed' && p.merged ? 'merged' : p.state));
  }
  // Default: open only.
  if (!states) items = items.filter((p) => p.state === 'open');
  items.sort((a, b) => b.number - a.number);
  const page = items.slice(0, first);
  const nodes = page.map((pull) => pullRecord(ctx.store, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    __nodes: nodes,
    __pageInfo: { __typename: 'PageInfo', hasNextPage: first < items.length, endCursor: null },
  };
}

function filesConnection(ctx: Ctx, repo: Repo, pull: Pull, field: FieldNode, variables: Record<string, unknown>): AnyRecord {
  const first = (argValue(field, 'first', variables) as number | undefined) ?? 10;
  const baseCommit = ctx.store.getObject(repo, pull.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const headCommit = headTip ? ctx.store.getObject(repo, headTip) : undefined;
  let paths: string[] = [];
  if (baseCommit && headCommit && baseCommit.type === 'commit' && headCommit.type === 'commit') {
    const diff = ctx.store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    paths = diff.map((d) => d.path);
  }
  const page = paths.slice(0, first);
  return {
    __typename: 'PullRequestFileConnection',
    __nodes: page.map((path) => ({ __typename: 'PullRequestFile', path })),
    __pageInfo: { __typename: 'PageInfo', hasNextPage: first < paths.length, endCursor: null },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => ({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    repository: (ctx, _source, field, variables) => {
      const owner = argValue(field, 'owner', variables) as string | undefined;
      const name = argValue(field, 'name', variables) as string | undefined;
      if (owner !== VIEWER_LOGIN || !name) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoRecord(ctx.store, repo) : null;
    },
    node: (ctx, _source, field, variables) => {
      const id = argValue(field, 'id', variables);
      const resolved = resolveNodeId(ctx.store, id);
      if (!resolved) return null;
      if (resolved.kind === 'Repository') return repoRecord(ctx.store, resolved.repo);
      if (resolved.kind === 'Issue' && resolved.issue) return issueRecord(ctx.store, resolved.repo, resolved.issue);
      if (resolved.kind === 'PullRequest' && resolved.pull) return pullRecord(ctx.store, resolved.repo, resolved.pull);
      return null;
    },
    __type: (_ctx, _source, field, variables) => {
      const name = argValue(field, 'name', variables) as string | undefined;
      if (!name) return null;
      return { __typename: '__Type', __typeName: name };
    },
  },
  Mutation: {
    createIssue: (ctx, _source, field, variables) => {
      const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) return { __typename: 'CreateIssuePayload', __issue: null };
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      ctx.store.invalidateRepo(repo);
      return { __typename: 'CreateIssuePayload', __issue: issueRecord(ctx.store, repo, issue) };
    },
    closeIssue: (ctx, _source, field, variables) => {
      const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
      const resolved = resolveNodeId(ctx.store, input.issueId);
      if (!resolved || resolved.kind !== 'Issue' || !resolved.issue) {
        return { __typename: 'CloseIssuePayload', __issue: null };
      }
      resolved.issue.state = 'closed';
      ctx.store.invalidateIssue(resolved.repo, resolved.issue.number);
      ctx.store.invalidateRepo(resolved.repo);
      return { __typename: 'CloseIssuePayload', __issue: issueRecord(ctx.store, resolved.repo, resolved.issue) };
    },
    createPullRequest: (ctx, _source, field, variables) => {
      const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) return { __typename: 'CreatePullRequestPayload', __pull: null };
      const baseRefName = String(input.baseRefName ?? repo.defaultBranch);
      const headRefName = String(input.headRefName ?? '');
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRefName, baseRefName);
      if (!pull) return { __typename: 'CreatePullRequestPayload', __pull: null };
      ctx.store.invalidateRepo(repo);
      return { __typename: 'CreatePullRequestPayload', __pull: pullRecord(ctx.store, repo, pull) };
    },
    mergePullRequest: (ctx, _source, field, variables) => {
      const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
      const resolved = resolveNodeId(ctx.store, input.pullRequestId);
      if (!resolved || resolved.kind !== 'PullRequest' || !resolved.pull) {
        return { __typename: 'MergePullRequestPayload', __pull: null };
      }
      const pull = resolved.pull;
      if (pull.state === 'open') {
        ctx.store.squashMerge(resolved.repo, pull);
      }
      return { __typename: 'MergePullRequestPayload', __pull: pullRecord(ctx.store, resolved.repo, pull) };
    },
    addComment: (ctx, _source, field, variables) => {
      const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
      const resolved = resolveNodeId(ctx.store, input.subjectId);
      if (!resolved || !resolved.issue) {
        return { __typename: 'AddCommentPayload', __comment: null };
      }
      const comment = { id: ctx.store.nextNodeId++, body: String(input.body ?? ''), user: VIEWER_LOGIN };
      resolved.issue.comments.push(comment);
      ctx.store.invalidateIssue(resolved.repo, resolved.issue.number);
      const node = {
        __typename: 'IssueComment',
        id: encodeGlobalId('IssueComment', resolved.repo.dbId, resolved.issue.number, comment.id),
        body: comment.body,
      };
      return { __typename: 'AddCommentPayload', __comment: node };
    },
  },
  User: {
    login: () => VIEWER_LOGIN,
    id: () => encodeGlobalId('User', VIEWER_ID),
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Repository: {
    id: (_ctx, source) => encodeGlobalId('Repository', (source.__repo as Repo).dbId),
    databaseId: (_ctx, source) => (source.__repo as Repo).dbId,
    name: (_ctx, source) => (source.__repo as Repo).name,
    nameWithOwner: (_ctx, source) => {
      const repo = source.__repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    description: (_ctx, source) => (source.__repo as Repo).description,
    owner: () => ({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    defaultBranchRef: (ctx, source) => {
      const repo = source.__repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, __oid: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    issue: (ctx, source, field, variables) => {
      const repo = source.__repo as Repo;
      const number = argValue(field, 'number', variables) as number | undefined;
      if (number === undefined) return null;
      const item = repo.items.get(number);
      if (!item || item.kind !== 'issue') return null;
      return issueRecord(ctx.store, repo, item);
    },
    issues: (ctx, source, field, variables) => issueConnection(ctx, source.__repo as Repo, field, variables),
    pullRequest: (ctx, source, field, variables) => {
      const repo = source.__repo as Repo;
      const number = argValue(field, 'number', variables) as number | undefined;
      if (number === undefined) return null;
      const item = repo.items.get(number);
      if (!item || item.kind !== 'pull') return null;
      return pullRecord(ctx.store, repo, item);
    },
    pullRequests: (ctx, source, field, variables) => pullConnection(ctx, source.__repo as Repo, field, variables),
  },
  Issue: {
    id: (_ctx, source) => issueGlobalId(source.__repo as Repo, source.__issue as Issue),
    number: (_ctx, source) => (source.__issue as Issue).number,
    title: (_ctx, source) => (source.__issue as Issue).title,
    body: (_ctx, source) => (source.__issue as Issue).body,
    state: (_ctx, source) => ((source.__issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    labels: (_ctx, source) => ({
      __typename: 'LabelConnection',
      __nodes: (source.__issue as Issue).labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })),
    }),
    comments: (_ctx, source) => ({
      __typename: 'IssueCommentConnection',
      __nodes: (source.__issue as Issue).comments.map((c) => ({
        __typename: 'IssueComment',
        id: encodeGlobalId('IssueComment', (source.__repo as Repo).dbId, (source.__issue as Issue).number, c.id),
        body: c.body,
      })),
    }),
    repository: (ctx, source) => repoRecord(ctx.store, source.__repo as Repo),
  },
  PullRequest: {
    id: (_ctx, source) => pullGlobalId(source.__repo as Repo, source.__pull as Pull),
    number: (_ctx, source) => (source.__pull as Pull).number,
    title: (_ctx, source) => (source.__pull as Pull).title,
    body: (_ctx, source) => (source.__pull as Pull).body,
    state: (_ctx, source) => {
      const pull = source.__pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ctx, source) => (source.__pull as Pull).merged,
    mergeable: (ctx, source) => pullMergeable(ctx.store, source.__repo as Repo, source.__pull as Pull),
    headRefName: (_ctx, source) => (source.__pull as Pull).headRef,
    baseRefName: (_ctx, source) => (source.__pull as Pull).baseRef,
    headRef: (ctx, source) => {
      const pull = source.__pull as Pull;
      const repo = source.__repo as Repo;
      const tip = repo.refs.get(`refs/heads/${pull.headRef}`);
      return tip ? { __typename: 'Ref', name: pull.headRef, __oid: tip } : null;
    },
    baseRef: (ctx, source) => {
      const pull = source.__pull as Pull;
      const repo = source.__repo as Repo;
      const tip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      return tip ? { __typename: 'Ref', name: pull.baseRef, __oid: tip } : null;
    },
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    repository: (ctx, source) => repoRecord(ctx.store, source.__repo as Repo),
    files: (ctx, source, field, variables) => filesConnection(ctx, source.__repo as Repo, source.__pull as Pull, field, variables),
  },
  IssueConnection: {
    nodes: (_ctx, source) => source.__nodes as AnyRecord[],
    edges: (_ctx, source) => (source.__nodes as AnyRecord[]).map((node) => ({ __typename: 'IssueEdge', node, cursor: '' })),
    pageInfo: (_ctx, source) => source.__pageInfo as AnyRecord,
    totalCount: (_ctx, source) => (source.__nodes as AnyRecord[]).length,
  },
  PullRequestConnection: {
    nodes: (_ctx, source) => source.__nodes as AnyRecord[],
    edges: (_ctx, source) => (source.__nodes as AnyRecord[]).map((node) => ({ __typename: 'PullRequestEdge', node, cursor: '' })),
    pageInfo: (_ctx, source) => source.__pageInfo as AnyRecord,
    totalCount: (_ctx, source) => (source.__nodes as AnyRecord[]).length,
  },
  PullRequestFileConnection: {
    nodes: (_ctx, source) => source.__nodes as AnyRecord[],
    edges: (_ctx, source) => (source.__nodes as AnyRecord[]).map((node) => ({ __typename: 'PullRequestFileEdge', node, cursor: '' })),
    pageInfo: (_ctx, source) => source.__pageInfo as AnyRecord,
  },
  PullRequestFile: {
    path: (_ctx, source) => source.path as string,
  },
  IssueEdge: {
    node: (_ctx, source) => source.node as AnyRecord,
    cursor: (_ctx, source) => source.cursor as string,
  },
  PullRequestEdge: {
    node: (_ctx, source) => source.node as AnyRecord,
    cursor: (_ctx, source) => source.cursor as string,
  },
  PullRequestFileEdge: {
    node: (_ctx, source) => source.node as AnyRecord,
    cursor: (_ctx, source) => source.cursor as string,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: () => false,
    startCursor: (_ctx, source) => (source as { startCursor?: string }).startCursor ?? null,
    endCursor: (_ctx, source) => (source as { endCursor?: string | null }).endCursor ?? null,
  },
  Ref: {
    name: (_ctx, source) => source.name as string,
    target: (_ctx, source) => ({ __typename: 'Commit', oid: source.__oid as string }),
  },
  Commit: {
    oid: (_ctx, source) => source.oid as string,
  },
  Label: {
    name: (_ctx, source) => source.name as string,
    color: (_ctx, source) => source.color as string,
  },
  LabelConnection: {
    nodes: (_ctx, source) => source.__nodes as AnyRecord[],
  },
  IssueCommentConnection: {
    nodes: (_ctx, source) => source.__nodes as AnyRecord[],
  },
  IssueComment: {
    id: (_ctx, source) => source.id as string,
    body: (_ctx, source) => source.body as string,
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }),
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
  },
  CreateIssuePayload: {
    issue: (_ctx, source) => source.__issue as AnyRecord | null,
  },
  CloseIssuePayload: {
    issue: (_ctx, source) => source.__issue as AnyRecord | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source) => source.__pull as AnyRecord | null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source) => source.__pull as AnyRecord | null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => (source.__comment ? { __typename: 'IssueCommentEdge', node: source.__comment as AnyRecord } : null),
  },
  IssueCommentEdge: {
    node: (_ctx, source) => source.node as AnyRecord,
  },
  __Type: {
    fields: (_ctx, source, field, variables) => {
      const includeDeprecated = argValue(field, 'includeDeprecated', variables);
      void includeDeprecated;
      const names = TYPE_FIELDS[source.__typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (_ctx, source, field, variables) => {
      const includeDeprecated = argValue(field, 'includeDeprecated', variables);
      void includeDeprecated;
      const names = ENUM_VALUES[source.__typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    },
    name: (_ctx, source) => source.__typeName as string,
    kind: () => 'OBJECT',
  },
  __Field: {
    name: (_ctx, source) => source.name as string,
  },
  __EnumValue: {
    name: (_ctx, source) => source.name as string,
  },
};

// The executor needs to know each record's type to resolve nested selections. Records carry
// __typename; connection nodes are resolved through the parent's field resolver, which returns
// records that already carry __typename.
function executeSelection(
  ctx: Ctx,
  typeName: string,
  source: AnyRecord,
  fields: FieldNode[],
  variables: Record<string, unknown>,
): AnyRecord {
  const out: AnyRecord = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name.startsWith('...on:')) {
      const wanted = field.name.slice('...on:'.length);
      const actual = (source.__typename as string) ?? typeName;
      if (actual !== wanted) continue;
      if (field.selection) {
        Object.assign(out, executeSelection(ctx, typeName, source, field.selection, variables));
      }
      continue;
    }
    const value = resolveField(ctx, typeName, source, field, variables);
    out[key] = resolveSelectionValue(ctx, value, field, variables);
  }
  return out;
}

function resolveSelectionValue(ctx: Ctx, value: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object') {
        const rec = item as AnyRecord;
        return executeSelection(ctx, (rec.__typename as string) ?? 'Unknown', rec, field.selection!, variables);
      }
      return item;
    });
  }
  if (typeof value === 'object') {
    const rec = value as AnyRecord;
    return executeSelection(ctx, (rec.__typename as string) ?? 'Unknown', rec, field.selection, variables);
  }
  return value;
}

export interface GraphQLResult {
  data: AnyRecord | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document against the store. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { store, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: `Syntax Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'Syntax Error: empty document' }] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyRecord = { __typename: rootType };
  const data = executeSelection(ctx, rootType, root, operation.selection, variables);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
