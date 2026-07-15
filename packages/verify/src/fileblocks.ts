import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface FileBlock {
  path: string;
  content: string;
}

export interface PatchBlock {
  path: string;
  search: string;
  replace: string;
}

/**
 * Apollo's file-output convention: models emit complete files as
 *
 *   ```file:relative/path.ext
 *   <full file content>
 *   ```
 *
 * One fence per file, full content. This keeps execution model-agnostic —
 * no tool-calling support required — and trivially parseable/verifiable.
 */
export function parseFileBlocks(text: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  const pattern = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const path = match[1].trim();
    if (!path) continue;
    // Keep inner content exactly, minus the trailing newline before the closing fence.
    blocks.push({ path, content: match[2].replace(/\n$/, "") + "\n" });
  }
  return blocks;
}

/** Parse exact SEARCH/REPLACE patches used for large existing files. */
export function parsePatchBlocks(text: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  const pattern = /```patch:([^\n`]+)\n@@ SEARCH\n([\s\S]*?)\n@@ REPLACE\n([\s\S]*?)\n@@ END\n?```/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const path = match[1].trim();
    if (path) blocks.push({ path, search: match[2], replace: match[3] });
  }
  return blocks;
}

/**
 * Resolve exact patches entirely in memory. A search must occur once so stale
 * or ambiguous context cannot mutate the workspace. The result goes through
 * the same transactional full-file writer as ordinary one-shot output.
 */
export function materializePatchBlocks(workspace: string, patches: PatchBlock[]): FileBlock[] {
  const root = realpathSync(resolve(workspace));
  const contents = new Map<string, string>();
  for (const patch of patches) {
    const { target, rel } = safeTarget(root, patch.path);
    if (!existsSync(target) || lstatSync(target).isDirectory()) throw new Error(`patch target does not exist: "${patch.path}"`);
    const current = contents.get(rel) ?? readFileSync(target, "utf8");
    const first = current.indexOf(patch.search);
    const second = first < 0 ? -1 : current.indexOf(patch.search, first + patch.search.length);
    if (first < 0) throw new Error(`patch search not found in "${patch.path}"`);
    if (second >= 0) throw new Error(`patch search is not unique in "${patch.path}"`);
    contents.set(rel, `${current.slice(0, first)}${patch.replace}${current.slice(first + patch.search.length)}`);
  }
  return [...contents].map(([path, content]) => ({ path, content }));
}

export interface ApplyResult {
  written: string[];
}

/**
 * Write file blocks into the workspace. Refuses anything that escapes it
 * (absolute paths, traversal) — model output is untrusted.
 */
export function applyFileBlocks(workspace: string, blocks: FileBlock[]): ApplyResult {
  const root = realpathSync(resolve(workspace));
  const targets: Array<{ target: string; rel: string; content: string; existed: boolean; mode?: number; temp: string; backup?: string }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const { target, rel } = safeTarget(root, block.path);
    if (seen.has(rel)) throw new Error(`refusing duplicate file block: "${block.path}"`);
    seen.add(rel);
    const existed = existsSync(target);
    targets.push({
      target,
      rel,
      content: block.content,
      existed,
      mode: existed && !lstatSync(target).isDirectory() ? statSync(target).mode & 0o777 : undefined,
      temp: join(dirname(target), `.apollo-write-${process.pid}-${Date.now()}-${index}`),
      backup: existed && !lstatSync(target).isDirectory()
        ? join(dirname(target), `.apollo-backup-${process.pid}-${Date.now()}-${index}`)
        : undefined,
    });
  }

  const createdDirs: string[] = [];
  const committed: typeof targets = [];
  try {
    // Stage every output before replacing a single target. This also catches
    // permission/disk errors before the commit phase starts.
    for (const item of targets) {
      ensureDirectory(root, dirname(item.target), createdDirs);
      writeFileSync(item.temp, item.content, item.mode === undefined ? undefined : { mode: item.mode });
      if (item.backup) copyFileSync(item.target, item.backup);
    }
    for (const item of targets) {
      renameSync(item.temp, item.target);
      committed.push(item);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        if (item.existed && item.backup) {
          renameSync(item.backup, item.target);
        } else {
          rmSync(item.target, { force: true });
        }
      } catch {
        // Preserve the original failure; best-effort rollback continues for
        // every remaining committed target.
      }
    }
    for (const item of targets) {
      rmSync(item.temp, { force: true });
      if (item.backup) rmSync(item.backup, { force: true });
    }
    for (const dir of createdDirs.reverse()) {
      try { rmdirSync(dir); } catch { /* non-empty or already removed */ }
    }
    throw error;
  }
  for (const item of targets) if (item.backup) rmSync(item.backup, { force: true });
  return { written: targets.map((item) => item.rel) };
}

function safeTarget(root: string, path: string): { target: string; rel: string } {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(root, rel) !== target) {
    throw new Error(`refusing to write outside the workspace: "${path}"`);
  }
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`refusing to write through a symbolic link: "${path}"`);
    }
  }
  return { target, rel };
}

function ensureDirectory(root: string, directory: string, created: string[]): void {
  if (directory === root || existsSync(directory)) return;
  ensureDirectory(root, dirname(directory), created);
  mkdirSync(directory);
  created.push(directory);
}

/** The instruction block `apollo run --apply` prepends so models use the convention. */
export const FILE_BLOCK_INSTRUCTIONS = `When your answer includes files, output each file as a fenced block in EXACTLY this format:

\`\`\`file:relative/path/to/file.ext
<complete file content>
\`\`\`

Rules: one fence per file; always the COMPLETE file content (never fragments or "..."), paths relative to the project root; use no other fenced code blocks. Brief prose outside the fences is fine.`;

export const PATCH_BLOCK_INSTRUCTIONS = `When editing existing files, output each exact replacement as a fenced block in EXACTLY this format:

\`\`\`patch:relative/path/to/file.ext
@@ SEARCH
<exact unique text copied from the supplied file>
@@ REPLACE
<replacement text>
@@ END
\`\`\`

Rules: SEARCH must match exactly once; use multiple patch fences for separate edits; paths are relative to the project root; do not mix patch and file fences.`;
