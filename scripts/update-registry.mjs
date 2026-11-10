#!/usr/bin/env node
/**
 * Updates model-context-registry.json with the context sizes NVIDIA and OpenAI publish on their own sites.
 *
 * Run by .github/workflows/update-registry.yml twice a day, or by hand:
 *   node scripts/update-registry.mjs            read both sites and write the file when something changed
 *   node scripts/update-registry.mjs --dry-run  read and report, write nothing
 *
 * It needs no key: NVIDIA's model list and pages, and OpenAI's documentation, are public.
 *
 * Each provider is read on its own. When one provider's site cannot be read, that provider's entries stay as they are,
 * the other provider is still updated and written, and the run ends with a failure so the problem shows as a red run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listNvidiaModels, readNvidiaModelPage } from "./nvidia-build-catalog.mjs";
import { listOpenAiModels, readOpenAiModelPage } from "./openai-docs-catalog.mjs";
import { checkRegistry, mergePageEntries, PAGE_SOURCES, withEntries } from "./registry.mjs";

const REGISTRY_PATH = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "model-context-registry.json");
/** How long one request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How many pages are read at the same time, to stay gentle with each site. */
const PAGES_AT_ONCE = 4;

const PROVIDERS = [
  { name: "NVIDIA", source: PAGE_SOURCES.nvidia, list: listNvidiaModels, read: readNvidiaModelPage },
  { name: "OpenAI", source: PAGE_SOURCES.openai, list: listOpenAiModels, read: readOpenAiModelPage },
];

async function readAllPages(read, modelIds) {
  const readings = new Map();
  let next = 0;
  async function worker() {
    while (next < modelIds.length) {
      const modelId = modelIds[next++];
      readings.set(modelId, await read(fetch, modelId, REQUEST_TIMEOUT_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, modelIds.length) }, worker));
  return readings;
}

function describe(name, report, readings, modelIds) {
  const sizes = [...readings.values()].filter((reading) => reading.kind === "size").length;
  return [
    `${name} lists ${modelIds.length} models; ${sizes} of their pages state a context size.`,
    ...report.added.map((item) => `added: ${item.modelId} = ${item.contextWindow}`),
    ...report.changed.map((item) => `changed: ${item.modelId} ${item.from} -> ${item.to}`),
    ...report.removed.map((item) => `removed (no longer in ${name}'s list): ${item.modelId}`),
    ...report.kept.map((item) => `kept ${item.modelId} = ${item.contextWindow}, because ${item.reason}`),
    ...report.skipped.map((item) => `skipped ${item.modelId}: ${item.reason}`),
  ].join("\n");
}

async function updateProvider(provider, entries, now) {
  const modelIds = await provider.list(fetch, REQUEST_TIMEOUT_MS);
  if (modelIds.length === 0) throw new Error(`${provider.name}'s model list named no models. Its site may have changed.`);
  const readings = await readAllPages(provider.read, modelIds);
  if (![...readings.values()].some((reading) => reading.kind === "size")) {
    // Every page failing at once points to a change on the provider's site, not to every model losing its size.
    throw new Error(`None of ${provider.name}'s model pages gave a size. Its site may have changed.`);
  }
  const { entries: merged, report } = mergePageEntries(entries, provider.source, modelIds, readings, now);
  return { entries: merged, summary: describe(provider.name, report, readings, modelIds) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const previous = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const previousErrors = checkRegistry(previous);
  if (previousErrors.length > 0) {
    throw new Error(`model-context-registry.json is already invalid, so nothing was changed. Fix it first:\n- ${previousErrors.join("\n- ")}`);
  }

  const now = new Date();
  let entries = previous.entries;
  const summaries = [];
  const failures = [];
  for (const provider of PROVIDERS) {
    try {
      const result = await updateProvider(provider, entries, now);
      entries = result.entries;
      summaries.push(result.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${provider.name}: ${message}`);
      summaries.push(`${provider.name} was not updated: ${message}`);
    }
  }

  const { document, changed } = withEntries(previous, entries, now);
  const errors = checkRegistry(document);
  if (errors.length > 0) throw new Error(`The updated registry would be refused by Weehzi, so it was not written:\n- ${errors.join("\n- ")}`);

  const summary = `${summaries.join("\n\n")}\n\n${changed ? (dryRun ? "Changes found (dry run: not written)." : `Written as version ${document.registryVersion}.`) : "No change."}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${summary}\n\`\`\`\n`);
  if (changed && !dryRun) fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (failures.length > 0) {
    console.error(`\nNot every provider could be read:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
