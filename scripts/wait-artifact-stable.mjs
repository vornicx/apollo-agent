import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/wait-artifact-stable.mjs <artifact> [...]");
  process.exit(2);
}

const intervalMs = 2_000;
const requiredMatches = 5;
const timeoutMs = 180_000;

for (const file of files) await waitForStable(file);

async function waitForStable(file) {
  const started = Date.now();
  let previous;
  let matches = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const stat = statSync(file, { bigint: true });
      const hash = await sha256(file);
      const current = `${stat.size}:${stat.mtimeNs}:${hash}`;
      matches = current === previous ? matches + 1 : 1;
      previous = current;
      if (matches >= requiredMatches) {
        console.log(`stable: ${file} (${stat.size} bytes, sha256 ${hash})`);
        return;
      }
    } catch {
      matches = 0;
      previous = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`artifact did not stabilize within ${timeoutMs / 1_000}s: ${file}`);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
