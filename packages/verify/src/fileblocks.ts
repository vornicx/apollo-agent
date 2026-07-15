import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export interface FileBlock {
  path: string;
  content: string;
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

export interface ApplyResult {
  written: string[];
}

/**
 * Write file blocks into the workspace. Refuses anything that escapes it
 * (absolute paths, traversal) — model output is untrusted.
 */
export function applyFileBlocks(workspace: string, blocks: FileBlock[]): ApplyResult {
  const root = resolve(workspace);
  const targets: Array<{ target: string; rel: string; content: string }> = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const target = resolve(root, block.path);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(root, rel) !== target) {
      throw new Error(`refusing to write outside the workspace: "${block.path}"`);
    }
    if (seen.has(rel)) throw new Error(`refusing duplicate file block: "${block.path}"`);
    seen.add(rel);
    targets.push({ target, rel, content: block.content });
  }
  // Validate every model-provided path before the first mutation so a bad
  // later block cannot leave a partially applied response.
  const written: string[] = [];
  for (const item of targets) {
    const { target, rel, content } = item;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(rel);
  }
  return { written };
}

/** The instruction block `apollo run --apply` prepends so models use the convention. */
export const FILE_BLOCK_INSTRUCTIONS = `When your answer includes files, output each file as a fenced block in EXACTLY this format:

\`\`\`file:relative/path/to/file.ext
<complete file content>
\`\`\`

Rules: one fence per file; always the COMPLETE file content (never fragments or "..."), paths relative to the project root; use no other fenced code blocks. Brief prose outside the fences is fine.`;
