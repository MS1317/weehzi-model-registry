#!/usr/bin/env node
/**
 * Updates model-profiles.json with what NVIDIA, OpenAI, Anthropic, Google and Ollama say about their models on their
 * own sites (see scripts/profiles/). Run by .github/workflows/update-registry.yml with the context registry, or by hand:
 *   node scripts/update-profiles.mjs            read every site and write the file when something changed
 *   node scripts/update-profiles.mjs --dry-run  read and report, write nothing
 *
 * It needs no key: every source is public. Each provider is read on its own; when one provider's list cannot be read,
 * its entries stay as they are, the others are still written, and the run ends with a failure so it shows as red.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listNvidiaModels, nvidiaModelPageUrl } from "./nvidia-build-catalog.mjs";
import { listOpenAiModels, openAiModelPageUrl } from "./openai-docs-catalog.mjs";
import { readNvidiaProfile } from "./profiles/nvidia-profile.mjs";
import { readOpenAiProfile } from "./profiles/openai-profile.mjs";
import { anthropicModelPageUrl, listAnthropicModelPages, readAnthropicProfile } from "./profiles/anthropic-profile.mjs";
import { geminiModelPageUrl, listGeminiModels, readGeminiProfile } from "./profiles/gemini-profile.mjs";
import { listOllamaModels, ollamaLibraryPageUrl, readOllamaModelProfile } from "./profiles/ollama-profile.mjs";
import { checkProfiles, mergeProviderProfiles, PROFILE_SCHEMA_VERSION } from "./profiles/profiles.mjs";

const FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "model-profiles.json");
const REQUEST_TIMEOUT_MS = 30_000;
const PAGES_AT_ONCE = 4;

/** The provider ids are Weehzi's own provider ids (packages/ai-providers/src/providers.config.ts). */
const PROVIDERS = [
  { id: "nvidia", name: "NVIDIA", list: listNvidiaModels, read: readNvidiaProfile, sourceFor: nvidiaModelPageUrl },
  { id: "openai", name: "OpenAI", list: listOpenAiModels, read: readOpenAiProfile, sourceFor: openAiModelPageUrl },
  { id: "anthropic", name: "Anthropic", list: listAnthropicModelPages, read: readAnthropicProfile, sourceFor: anthropicModelPageUrl },
  { id: "gemini", name: "Google Gemini", list: listGeminiModels, read: readGeminiProfile, sourceFor: geminiModelPageUrl },
  { id: "ollama", name: "Ollama", list: listOllamaModels, read: readOllamaModelProfile, sourceFor: ollamaLibraryPageUrl },
];

async function readAll(read, ids) {
  const readings = new Map();
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      readings.set(id, await read(fetch, id, REQUEST_TIMEOUT_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, ids.length) }, worker));
  return readings;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const current = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { schemaVersion: PROFILE_SCHEMA_VERSION, generatedAt: new Date(0).toISOString(), entries: [] };
  const now = new Date().toISOString();
  let entries = current.entries;
  let failed = false;
  for (const provider of PROVIDERS) {
    try {
      const ids = await provider.list(fetch, REQUEST_TIMEOUT_MS);
      if (ids.length === 0) throw new Error("the list named no models; the site may have changed");
      const readings = await readAll(provider.read, ids);
      const { entries: providerEntries, report } = mergeProviderProfiles(entries, provider.id, readings, ids, provider.sourceFor, now);
      entries = [...entries.filter((entry) => entry.provider !== provider.id), ...providerEntries];
      const read = [...readings.values()].filter((reading) => reading.kind === "profile").length;
      console.log(`${provider.name}: lists ${ids.length}; ${read} pages read; ${report.updated.length} updated, ${report.unchanged.length} unchanged, ${report.kept.length} kept from before, ${report.removed.length} removed.`);
      for (const item of report.kept) console.log(`  kept ${item.modelId}: ${item.reason}`);
      for (const [id, reading] of readings) if (reading.kind !== "profile" && !report.kept.some((item) => item.modelId === id)) console.log(`  skipped ${id}: ${reading.reason}`);
    } catch (error) {
      failed = true;
      console.error(`${provider.name}: could not be read: ${error instanceof Error ? error.message : String(error)}. Its entries stay as they were.`);
    }
  }
  entries.sort((a, b) => (a.provider === b.provider ? a.modelId.localeCompare(b.modelId) : a.provider.localeCompare(b.provider)));
  const changed = JSON.stringify(entries) !== JSON.stringify(current.entries);
  const document = { schemaVersion: PROFILE_SCHEMA_VERSION, generatedAt: changed ? now : current.generatedAt, entries };
  const errors = checkProfiles(document);
  if (errors.length > 0) {
    console.error(`The result would be refused by Weehzi, so nothing was written:\n${errors.slice(0, 40).map((error) => `  ${error}`).join("\n")}`);
    process.exit(1);
  }
  if (!changed) console.log("No change.");
  else if (dryRun) console.log(`Dry run: ${entries.length} entries would be written.`);
  else {
    fs.writeFileSync(FILE, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`Wrote ${entries.length} entries to model-profiles.json.`);
  }
  if (failed) process.exit(1);
}

await main();
