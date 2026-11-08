#!/usr/bin/env node
/**
 * Updates model-context-registry.json with the context sizes NVIDIA publishes on build.nvidia.com.
 *
 * Run by .github/workflows/update-registry.yml every day, or by hand:
 *   node scripts/update-registry.mjs            read NVIDIA's site and write the file when something changed
 *   node scripts/update-registry.mjs --dry-run  read and report, write nothing
 *
 * It needs no key: NVIDIA's model list and model pages are public.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listNvidiaModels, readNvidiaModelPage } from "./nvidia-build-catalog.mjs";
import { checkRegistry, mergeNvidiaEntries } from "./registry.mjs";

const REGISTRY_PATH = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "model-context-registry.json");
/** How long one request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How many pages are read at the same time, to stay gentle with NVIDIA's site. */
const PAGES_AT_ONCE = 4;

async function readAllPages(modelIds) {
  const readings = new Map();
  let next = 0;
  async function worker() {
    while (next < modelIds.length) {
      const modelId = modelIds[next++];
      readings.set(modelId, await readNvidiaModelPage(fetch, modelId, REQUEST_TIMEOUT_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, modelIds.length) }, worker));
  return readings;
}

function describe(report, readings, modelIds) {
  const sizes = [...readings.values()].filter((reading) => reading.kind === "size").length;
  const lines = [
    `NVIDIA lists ${modelIds.length} models; ${sizes} of their pages state a context size.`,
    ...report.added.map((item) => `added: ${item.modelId} = ${item.contextWindow}`),
    ...report.changed.map((item) => `changed: ${item.modelId} ${item.from} -> ${item.to}`),
    ...report.removed.map((item) => `removed (no longer in NVIDIA's list): ${item.modelId}`),
    ...report.kept.map((item) => `kept ${item.modelId} = ${item.contextWindow}, because ${item.reason}`),
    ...report.skipped.map((item) => `skipped ${item.modelId}: ${item.reason}`),
  ];
  return lines.join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const previous = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const previousErrors = checkRegistry(previous);
  if (previousErrors.length > 0) {
    throw new Error(`model-context-registry.json is already invalid, so nothing was changed. Fix it first:\n- ${previousErrors.join("\n- ")}`);
  }

  const modelIds = await listNvidiaModels(fetch, REQUEST_TIMEOUT_MS);
  const readings = await readAllPages(modelIds);
  if (modelIds.length > 0 && ![...readings.values()].some((reading) => reading.kind === "size")) {
    // Every page failing at once points to a change on NVIDIA's site, not to every model losing its size.
    throw new Error("None of NVIDIA's model pages gave a size, so nothing was changed. NVIDIA's site may have changed.");
  }

  const { document, changed, report } = mergeNvidiaEntries(previous, modelIds, readings, new Date());
  const errors = checkRegistry(document);
  if (errors.length > 0) throw new Error(`The updated registry would be refused by Weehzi, so it was not written:\n- ${errors.join("\n- ")}`);

  const summary = `${describe(report, readings, modelIds)}\n${changed ? (dryRun ? "Changes found (dry run: not written)." : `Written as version ${document.registryVersion}.`) : "No change."}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${summary}\n\`\`\`\n`);
  if (changed && !dryRun) fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
