// store.ts — the forge's entire state: repositories, git objects, refs, issues, pull requests.
// Everything lives in memory; nothing is written to disk. Timestamps are fixed so that two
// runs over the same inputs leave byte-identical observable state.
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
// Fixed author/committer identity for commits the forge creates itself (contents API, merges).
export const FORGE_AUTHOR = `${VIEWER_NAME} <${VIEWER_EMAIL}> 1735689600 +0000`;
export const FIXED_ISO = '2025-01-01T00:00:00Z';

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS-based line diff counts for small files. */
function lcsDiff(a: string[], b: string[]): { additions: number; deletions: number } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]; computed backwards with two rows.
  let next = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    cur[m] = 0;
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], cur[j + 1]);
    }
    [next, cur] = [cur, next];
  }
  const lcs = next[0];
  return { additions: m - lcs, deletions: n - lcs };
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Head branch tip at creation; base branch tip at creation (the merge base). */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export type Item = Issue | Pull;

export interface Repo {
  owner: string;
  name: string;
  dbId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  items: Map<number, Item>;
  counter: number;
  createdAt: string;
  updatedAt: string;
  /** Cached serialised repo JSON (invalidated on mutation). */
  cachedRepoJson: string | null;
  /** Cached serialised issue JSON per issue number (invalidated on mutation). */
  issueCache: Map<number, string>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 5000;
  nextNodeId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo: Repo = {
      owner,
      name,
      dbId: this.nextDbId++,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      items: new Map(),
      counter: 0,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      cachedRepoJson: null,
      issueCache: new Map(),
    };
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    // Creation order: databaseId ascending.
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // git objects
  // -----------------------------------------------------------------------------------------

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const obj of objects) {
      const oid = objectId(obj.type, obj.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
    }
  }

  /** All objects reachable from a commit: the commit, its tree closure. Ancestors NOT included. */
  closureOfCommit(repo: Repo, commitOid: string, out: Map<string, GitObject>): void {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return;
    out.set(commitOid, commit);
    const view = parseCommit(commit.data);
    this.closureOfTree(repo, view.tree, out);
  }

  closureOfTree(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') {
        this.closureOfTree(repo, entry.oid, out);
      } else {
        const blob = repo.objects.get(entry.oid);
        if (blob && !out.has(entry.oid)) out.set(entry.oid, blob);
      }
    }
  }

  /** Full object closure of a commit set: commits + trees + blobs, following parents. */
  closureOfHistory(repo: Repo, tips: Iterable<string>, stopAtShallow: Set<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const seenCommits = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      out.set(oid, commit);
      this.closureOfTree(repo, parseCommit(commit.data).tree, out);
      if (stopAtShallow.has(oid)) continue;
      for (const parent of parseCommit(commit.data).parents) stack.push(parent);
    }
    return out;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** Build (or rebuild) the tree for a path change: returns the new root tree oid. */
  writePath(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null, mode = '100644'): string {
    const parts = path.split('/').filter((p) => p.length > 0);
    const build = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = [];
      const existing = treeOid ? repo.objects.get(treeOid) : undefined;
      if (existing && existing.type === 'tree') {
        for (const e of parseTree(existing.data)) entries.push({ ...e });
      }
      const name = parts[depth]!;
      const idx = entries.findIndex((e) => e.name === name);
      if (depth === parts.length - 1) {
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode, name, oid: blobOid };
        } else {
          entries.push({ mode, name, oid: blobOid });
        }
      } else {
        const childOid = idx >= 0 && entries[idx]!.mode === '40000' ? entries[idx]!.oid : null;
        const newChild = build(childOid, depth + 1);
        const childEntries = repo.objects.get(newChild);
        const empty = childEntries !== undefined && childEntries.type === 'tree' && parseTree(childEntries.data).length === 0;
        if (empty) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build(rootTreeOid, 0);
  }

  /** Create a commit on a ref (or unborn) for a single-file contents change. */
  commitFile(
    repo: Repo,
    ref: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    const tip = repo.refs.get(ref) ?? null;
    let parentTree: string | null = null;
    const parents: string[] = [];
    if (tip) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') {
        parentTree = parseCommit(commit.data).tree;
        parents.push(tip);
      }
    }
    const treeOid = this.writePath(repo, parentTree, path, blobSha);
    const commitData = buildCommit({ tree: treeOid, parents, author: FORGE_AUTHOR, committer: FORGE_AUTHOR, message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    repo.cachedRepoJson = null;
    return { commitSha, blobSha };
  }

  /** Resolve a revision: full oid, branch name, or refs/heads/<name>. */
  resolveRevision(repo: Repo, rev: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(rev)) {
      return repo.objects.has(rev.toLowerCase()) ? rev.toLowerCase() : null;
    }
    if (rev.startsWith('refs/')) {
      const oid = repo.refs.get(rev);
      return oid ?? null;
    }
    const head = repo.refs.get(`refs/heads/${rev}`);
    if (head) return head;
    const tag = repo.refs.get(`refs/tags/${rev}`);
    if (tag) {
      const obj = repo.objects.get(tag);
      if (obj && obj.type === 'tag') return parseTag(obj.data).object;
      return tag;
    }
    return null;
  }

  /** First-parent walk from a tip, newest first. */
  walkFirstParent(repo: Repo, tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = tipOid;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const commit = repo.objects.get(cur);
      if (!commit || commit.type !== 'commit') break;
      out.push(cur);
      cur = parseCommit(commit.data).parents[0] ?? null;
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` through any parent chain. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      for (const parent of parseCommit(commit.data).parents) stack.push(parent);
    }
    return false;
  }

  // -----------------------------------------------------------------------------------------
  // fetch planning
  // -----------------------------------------------------------------------------------------

  /**
   * Plan a fetch: which commits to send, and the shallow boundary changes.
   * wants: tip oids; haves: oids the peer holds; shallow: the peer's current shallow
   * boundaries; depth: deepen N (undefined = full).
   */
  planFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallow: readonly string[],
    depth: number | undefined,
  ): { included: Set<string>; newShallow: string[]; unshallow: string[]; tags: Set<string> } {
    const haveSet = new Set(haves.map((o) => o.toLowerCase()));
    const shallowSet = new Set(shallow.map((o) => o.toLowerCase()));
    const included = new Set<string>();
    const tags = new Set<string>();
    const newShallow = new Set<string>();
    const unshallow = new Set<string>();
    const best = new Map<string, number>();
    const queue: Array<{ oid: string; remaining: number }> = [];
    for (const want of wants) {
      const oid = want.toLowerCase();
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      const r = depth === undefined ? Number.POSITIVE_INFINITY : depth;
      if (obj.type === 'tag') {
        // An annotated tag want delivers the tag object plus its target's closure.
        tags.add(oid);
        queue.push({ oid: parseTag(obj.data).object, remaining: r });
        continue;
      }
      queue.push({ oid, remaining: r });
    }
    while (queue.length) {
      const { oid, remaining } = queue.pop()!;
      const prev = best.get(oid);
      if (prev !== undefined && prev >= remaining) continue;
      best.set(oid, remaining);
      const commit = repo.objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      const isHave = haveSet.has(oid);
      if (isHave && !shallowSet.has(oid)) continue; // peer holds it and its history
      if (isHave && shallowSet.has(oid)) {
        // Peer holds the commit but not its parents.
        if (remaining > 1) {
          unshallow.add(oid);
          for (const parent of parseCommit(commit.data).parents) {
            queue.push({ oid: parent, remaining: remaining - 1 });
          }
        }
        // remaining <= 1: stays a boundary; nothing to do.
        continue;
      }
      included.add(oid);
      if (remaining <= 1) {
        newShallow.add(oid);
        continue;
      }
      for (const parent of parseCommit(commit.data).parents) {
        queue.push({ oid: parent, remaining: remaining - 1 });
      }
    }
    return { included, newShallow: [...newShallow], unshallow: [...unshallow], tags };
  }

  /**
   * The exact object set a fetch sends: closure of the included commits, minus everything
   * the peer already holds (haves' full history, or just the boundary commit for shallow
   * boundaries). No deltas are ever sent.
   */
  fetchObjects(
    repo: Repo,
    included: Set<string>,
    haves: readonly string[],
    shallow: readonly string[],
    tags: ReadonlySet<string> = new Set(),
  ): Map<string, GitObject> {
    const send = new Map<string, GitObject>();
    for (const oid of included) this.closureOfCommit(repo, oid, send);
    for (const tagOid of tags) {
      const tag = repo.objects.get(tagOid);
      if (tag) send.set(tagOid, tag);
    }
    const shallowSet = new Set(shallow.map((o) => o.toLowerCase()));
    const held = this.closureOfHistory(repo, haves, shallowSet);
    for (const oid of held.keys()) send.delete(oid);
    return send;
  }

  // -----------------------------------------------------------------------------------------
  // issues / pull requests
  // -----------------------------------------------------------------------------------------

  nextNumber(repo: Repo): number {
    repo.counter += 1;
    return repo.counter;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      kind: 'issue',
      id: this.nextNodeId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels,
      comments: [],
    };
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    // Duplicate open PR with the same head+base is refused.
    for (const item of repo.items.values()) {
      if (item.kind === 'pull' && item.state === 'open' && item.headRef === headRef && item.baseRef === baseRef) {
        return null;
      }
    }
    const pull: Pull = {
      kind: 'pull',
      id: this.nextNodeId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.items.set(pull.number, pull);
    return pull;
  }

  /** Diff two trees: additions/deletions counted in lines of the blob bytes. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string | null,
    headTreeOid: string | null,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const base = baseTreeOid ? this.flattenTree(repo, baseTreeOid) : new Map();
    const head = headTreeOid ? this.flattenTree(repo, headTreeOid) : new Map();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    const lineCount = (oid: string | undefined): number => {
      if (!oid) return 0;
      const obj = repo.objects.get(oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      if (text.length === 0) return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const deletions = lineCount(b.oid);
        out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const additions = lineCount(h.oid);
        out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        // Exact line diff (LCS) so reordered or duplicated lines still count.
        const bObj = repo.objects.get(b.oid);
        const hObj = repo.objects.get(h.oid);
        const bLines = splitLines(bObj ? bObj.data.toString('utf8') : '');
        const hLines = splitLines(hObj ? hObj.data.toString('utf8') : '');
        const { additions, deletions } = lcsDiff(bLines, hLines);
        out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** The 3-way merge check: does merging head into current (from base) conflict? */
  mergeConflict(repo: Repo, baseTreeOid: string, currentTreeOid: string, headTreeOid: string): boolean {
    const base = this.flattenTree(repo, baseTreeOid);
    const current = this.flattenTree(repo, currentTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...current.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path)?.oid ?? null;
      const c = current.get(path)?.oid ?? null;
      const h = head.get(path)?.oid ?? null;
      if (c === h) continue;
      if (b === c) continue; // current unchanged: take head
      if (b === h) continue; // head unchanged: take current
      return true; // differs in all three
    }
    return false;
  }

  /** Perform a squash merge. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return null;
    const headCommit = repo.objects.get(headTip);
    const baseCommit = repo.objects.get(baseTip);
    const mergeBaseCommit = repo.objects.get(pull.baseSha);
    if (!headCommit || !baseCommit || !mergeBaseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit' || mergeBaseCommit.type !== 'commit') {
      return null;
    }
    const baseTree = parseCommit(mergeBaseCommit.data).tree;
    const currentTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    if (this.mergeConflict(repo, baseTree, currentTree, headTree)) return null;
    // Build the merged tree: per path, head wins unless head is unchanged from base.
    const base = this.flattenTree(repo, baseTree);
    const current = this.flattenTree(repo, currentTree);
    const head = this.flattenTree(repo, headTree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...base.keys(), ...current.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path)?.oid ?? null;
      const c = current.get(path);
      const h = head.get(path);
      if (h && b === h?.oid) {
        if (c) merged.set(path, c); // head unchanged: keep current
      } else if (h) {
        merged.set(path, h); // head changed: take head
      } else if (c && b === c.oid) {
        // deleted on head, unchanged on current: delete (omit)
      } else if (c) {
        merged.set(path, c); // deleted on head but changed on current: keep current
      }
    }
    // Rebuild nested trees from the flat map.
    const mergedTreeOid = this.buildTreeFromFlat(repo, merged);
    const message = pull.title;
    const commitData = buildCommit({ tree: mergedTreeOid, parents: [baseTip], author: FORGE_AUTHOR, committer: FORGE_AUTHOR, message });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    repo.cachedRepoJson = null;
    repo.issueCache.clear();
    return mergeSha;
  }

  /** Rebuild a nested tree from a flat path -> {oid, mode} map. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    // Group by directory, bottom-up.
    const byDir = new Map<string, TreeEntry[]>();
    for (const [path, entry] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ mode: entry.mode, name, oid: entry.oid });
      byDir.set(dir, list);
      // Ensure every ancestor directory exists, even when it holds no direct file.
      let ancestor = dir;
      while (ancestor !== '') {
        if (!byDir.has(ancestor)) byDir.set(ancestor, []);
        const cut = ancestor.lastIndexOf('/');
        ancestor = cut < 0 ? '' : ancestor.slice(0, cut);
      }
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [...(byDir.get(dir) ?? [])];
      // Subdirectories of this dir become tree entries (never the dir itself).
      for (const [sub, list] of byDir) {
        if (sub === dir || list.length === 0) continue;
        const slash = sub.lastIndexOf('/');
        const parent = slash < 0 ? '' : sub.slice(0, slash);
        if (parent === dir) {
          const name = slash < 0 ? sub : sub.slice(slash + 1);
          entries.push({ mode: '40000', name, oid: buildDir(sub) });
        }
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  invalidateRepo(repo: Repo): void {
    repo.cachedRepoJson = null;
  }

  invalidateIssue(repo: Repo, number: number): void {
    repo.issueCache.delete(number);
  }
}
