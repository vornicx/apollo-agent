export function unifiedDiff(path, before, after) {
  const oldLines = (before ?? "").split(/\r?\n/);
  const newLines = (after ?? "").split(/\r?\n/);
  if ((before ?? "") === (after ?? "")) return "";
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const object = trimmed.match(/\{[\s\S]*\}/);
  if (!object) throw new Error("Model response did not contain JSON.");
  return object[0];
}
