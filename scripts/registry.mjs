import { nvidiaModelPageUrl } from "./nvidia-build-catalog.mjs";

/**
 * The rules Weehzi applies when it downloads this registry (packages/ai-providers/src/capabilities.ts,
 * validateModelContextRegistry). Weehzi refuses the WHOLE file when any entry breaks a rule, so the update job checks
 * every rule here and writes nothing when the result would be refused.
 */
const TOP_KEYS = ["schemaVersion", "registryVersion", "generatedAt", "expiresAt", "entries"];
const ENTRY_KEYS = ["provider", "modelId", "providerBaseUrl", "contextWindow", "maxOutputTokens", "aliases", "capabilities", "provenance", "expiresAt"];
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;

function isText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value;
}

function isTimestamp(value) {
  return isText(value, 64) && Number.isFinite(Date.parse(value));
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Whether `modelId` can be written into the registry without making Weehzi refuse the file. */
export function isRegistryModelId(modelId) {
  return isText(modelId, 256) && MODEL_ID.test(modelId);
}

/** Every rule the file breaks, as plain sentences; an empty list means Weehzi will accept it. */
export function checkRegistry(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["the registry must be an object"];
  for (const key of Object.keys(document)) if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level field "${key}"`);
  if (![1, 2, 3].includes(document.schemaVersion)) errors.push("schemaVersion must be 1, 2 or 3");
  if (!isText(document.registryVersion, 128)) errors.push("registryVersion must be non-empty text of at most 128 characters");
  if (!isTimestamp(document.generatedAt)) errors.push("generatedAt must be a timestamp");
  if (document.expiresAt !== undefined && !isTimestamp(document.expiresAt)) errors.push("expiresAt must be a timestamp");
  if (!Array.isArray(document.entries)) return [...errors, "entries must be a list"];

  const claimed = new Map();
  document.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key) || (key === "capabilities" && document.schemaVersion === 1)) errors.push(`${at} has field "${key}", which this schema version does not allow`);
    }
    if (!isText(entry.provider, 128) || !PROVIDER_ID.test(entry.provider)) errors.push(`${at}.provider is not a valid provider id`);
    if (!isRegistryModelId(entry.modelId)) errors.push(`${at}.modelId is not a valid model id`);
    if (!isPositiveInt(entry.contextWindow)) errors.push(`${at}.contextWindow must be a positive whole number`);
    if (entry.maxOutputTokens !== undefined && (!isPositiveInt(entry.maxOutputTokens) || entry.maxOutputTokens > entry.contextWindow)) {
      errors.push(`${at}.maxOutputTokens must be a positive whole number no larger than contextWindow`);
    }
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => !isRegistryModelId(alias))) errors.push(`${at}.aliases must be a list of valid model ids`);
      else if (new Set(entry.aliases).size !== entry.aliases.length || entry.aliases.includes(entry.modelId)) errors.push(`${at}.aliases repeats an id`);
    }
    const provenance = entry.provenance;
    if (!provenance || typeof provenance !== "object" || Object.keys(provenance).some((key) => key !== "source" && key !== "verifiedAt")
      || !isText(provenance.source, 2048) || !isTimestamp(provenance.verifiedAt)) {
      errors.push(`${at}.provenance must be { source, verifiedAt }`);
    }
    if (entry.expiresAt !== undefined && !isTimestamp(entry.expiresAt)) errors.push(`${at}.expiresAt must be a timestamp`);

    const scope = `${entry.provider}\u0000${entry.providerBaseUrl ?? ""}`;
    for (const id of [entry.modelId, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]) {
      const key = `${scope}\u0000${id}`;
      if (claimed.has(key)) errors.push(`${at} uses the id "${id}", which entries[${claimed.get(key)}] already uses`);
      else claimed.set(key, index);
    }
  });
  return errors;
}

/**
 * An entry this job wrote: an NVIDIA entry for NVIDIA's hosted address whose source is exactly the build.nvidia.com
 * page of its own model. Every other entry was written by a person and is never changed by the job.
 */
export function isNvidiaPageEntry(entry) {
  return entry?.provider === "nvidia"
    && entry.providerBaseUrl === undefined
    && entry.provenance?.source === nvidiaModelPageUrl(entry.modelId);
}

/** `YYYY-MM-DD.N`: N counts up within one day and starts again at 1 on a new day. */
export function nextRegistryVersion(previousVersion, now) {
  const today = now.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(previousVersion ?? "");
  return match && match[1] === today ? `${today}.${Number(match[2]) + 1}` : `${today}.1`;
}

/**
 * The registry after one read of NVIDIA's site.
 *
 * - Entries people wrote are kept exactly as they are, and a model a person already describes is not written again.
 * - A page that states a size gives the model an entry. When the size is the one already recorded, the entry is kept
 *   as it was (its `verifiedAt` is when that value was first read), so an unchanged day changes nothing.
 * - A page that fails, or that states no size, never removes a value already recorded: a change to NVIDIA's site must
 *   not wipe the registry. These are reported so a person can look.
 * - A model that has left NVIDIA's model list is removed.
 */
export function mergeNvidiaEntries(previous, modelIds, readings, now) {
  const people = previous.entries.filter((entry) => !isNvidiaPageEntry(entry));
  const recorded = new Map(previous.entries.filter(isNvidiaPageEntry).map((entry) => [entry.modelId, entry]));
  const describedByPeople = new Set(
    people.filter((entry) => entry.provider === "nvidia" && entry.providerBaseUrl === undefined).flatMap((entry) => [entry.modelId, ...(entry.aliases ?? [])]),
  );
  const report = { added: [], changed: [], kept: [], removed: [], skipped: [] };
  const generated = [];

  for (const modelId of modelIds) {
    if (describedByPeople.has(modelId)) continue;
    if (!isRegistryModelId(modelId)) {
      report.skipped.push({ modelId, reason: "the id has characters Weehzi does not accept" });
      continue;
    }
    const reading = readings.get(modelId) ?? { kind: "failed", reason: "not read" };
    const before = recorded.get(modelId);
    if (reading.kind === "size") {
      if (before?.contextWindow === reading.contextWindow) {
        generated.push(before);
        continue;
      }
      generated.push({
        provider: "nvidia",
        modelId,
        contextWindow: reading.contextWindow,
        provenance: { source: nvidiaModelPageUrl(modelId), verifiedAt: now.toISOString() },
      });
      if (before) report.changed.push({ modelId, from: before.contextWindow, to: reading.contextWindow });
      else report.added.push({ modelId, contextWindow: reading.contextWindow });
    } else if (before) {
      generated.push(before);
      report.kept.push({ modelId, contextWindow: before.contextWindow, reason: reading.kind === "no_size" ? "the page now states no size" : `the page could not be read (${reading.reason})` });
    }
  }
  const listed = new Set(modelIds);
  for (const modelId of recorded.keys()) if (!listed.has(modelId)) report.removed.push({ modelId });

  generated.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  const entries = [...people, ...generated];
  const changed = JSON.stringify(entries) !== JSON.stringify(previous.entries);
  const document = changed
    ? { ...previous, registryVersion: nextRegistryVersion(previous.registryVersion, now), generatedAt: now.toISOString(), entries }
    : previous;
  return { document, changed, report };
}
