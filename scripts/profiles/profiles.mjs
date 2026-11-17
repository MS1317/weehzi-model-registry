/**
 * The model profile file, model-profiles.json: what each provider says about its models on its own site, one entry per
 * exact provider and model id. Weehzi reads it next to the context registry and uses it to tell a person what each model
 * is for and how it is expected to behave (packages/shared/src/model-profile.ts in Weehzi).
 *
 * It is a separate file from model-context-registry.json on purpose: Weehzi refuses the whole context registry when one
 * entry has a field it does not know, so new facts must not be added there.
 *
 * Every rule here matches Weehzi's own check, so the job writes nothing that Weehzi would refuse.
 */

export const PROFILE_SCHEMA_VERSION = 1;
const TOP_KEYS = ["schemaVersion", "generatedAt", "entries"];
const ENTRY_KEYS = ["provider", "modelId", "profile", "provenance"];
export const PROFILE_KEYS = ["name", "summary", "purpose", "description", "labels", "parameters", "contextWindow", "maxOutputTokens", "inputModalities", "outputModalities", "toolCalling", "structuredOutput", "reasoning", "latency", "knowledgeCutoff", "price", "features", "lifecycle"];
const TEXT_LIMITS = { name: 120, summary: 300, purpose: 600, description: 600, knowledgeCutoff: 40 };
const LATENCY = ["fastest", "fast", "moderate", "slow", "slowest"];
const LIFECYCLE = ["active", "legacy", "deprecated", "retired"];
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;

const isText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const isList = (value, max, itemMax) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every((item) => isText(item, itemMax));
const isCount = (value) => Number.isSafeInteger(value) && value > 0;

function checkProfile(profile, at, errors) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return errors.push(`${at} must be an object`);
  for (const key of Object.keys(profile)) if (!PROFILE_KEYS.includes(key)) errors.push(`${at} has unknown field "${key}"`);
  for (const [key, max] of Object.entries(TEXT_LIMITS)) if (profile[key] !== undefined && !isText(profile[key], max)) errors.push(`${at}.${key} must be text of at most ${max} characters`);
  for (const key of ["labels", "inputModalities", "outputModalities"]) if (profile[key] !== undefined && !isList(profile[key], 24, 60)) errors.push(`${at}.${key} must be a short list of text`);
  if (profile.features !== undefined && !isList(profile.features, 64, 80)) errors.push(`${at}.features must be a list of text`);
  for (const key of ["parameters", "contextWindow", "maxOutputTokens"]) if (profile[key] !== undefined && !isCount(profile[key])) errors.push(`${at}.${key} must be a positive whole number`);
  for (const key of ["toolCalling", "structuredOutput", "reasoning"]) if (profile[key] !== undefined && typeof profile[key] !== "boolean") errors.push(`${at}.${key} must be true or false`);
  if (profile.latency !== undefined && !LATENCY.includes(profile.latency)) errors.push(`${at}.latency must be one of ${LATENCY.join(", ")}`);
  if (profile.price !== undefined) {
    const price = profile.price;
    const ok = price && typeof price === "object" && Object.keys(price).every((key) => key === "inputPerMillion" || key === "outputPerMillion") && [price.inputPerMillion, price.outputPerMillion].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (!ok) errors.push(`${at}.price must be { inputPerMillion, outputPerMillion } in US dollars`);
  }
  if (profile.lifecycle !== undefined) {
    const lifecycle = profile.lifecycle;
    const ok = lifecycle && typeof lifecycle === "object" && Object.keys(lifecycle).every((key) => key === "status" || key === "note") && LIFECYCLE.includes(lifecycle.status) && (lifecycle.note === undefined || isText(lifecycle.note, 300));
    if (!ok) errors.push(`${at}.lifecycle must be { status: ${LIFECYCLE.join("|")}, note? }`);
  }
  return undefined;
}

/** Every rule the file breaks, as plain sentences; an empty list means Weehzi accepts it. */
export function checkProfiles(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["the file must be an object"];
  for (const key of Object.keys(document)) if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level field "${key}"`);
  if (document.schemaVersion !== PROFILE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
  if (!isText(document.generatedAt, 64) || !Number.isFinite(Date.parse(document.generatedAt))) errors.push("generatedAt must be a timestamp");
  if (!Array.isArray(document.entries)) return [...errors, "entries must be a list"];
  const seen = new Set();
  document.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return errors.push(`${at} must be an object`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) errors.push(`${at} has unknown field "${key}"`);
    if (!isText(entry.provider, 128) || !PROVIDER_ID.test(entry.provider)) errors.push(`${at}.provider is not a valid provider id`);
    if (!isText(entry.modelId, 256) || !MODEL_ID.test(entry.modelId)) errors.push(`${at}.modelId is not a valid model id`);
    checkProfile(entry.profile, `${at}.profile`, errors);
    const provenance = entry.provenance;
    if (!provenance || typeof provenance !== "object" || Object.keys(provenance).some((key) => key !== "source" && key !== "readAt") || !isText(provenance.source, 2048) || !isText(provenance.readAt, 64) || !Number.isFinite(Date.parse(provenance.readAt))) {
      errors.push(`${at}.provenance must be { source, readAt }`);
    }
    const key = `${entry.provider}\u0000${entry.modelId}`;
    if (seen.has(key)) errors.push(`${at} repeats ${entry.provider} ${entry.modelId}`);
    seen.add(key);
  });
  return errors;
}

function sameProfile(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The new entries for one provider. A model whose page was read gets what the page says now; its `readAt` changes
 * only when what the page says changed. A model whose page failed keeps its old entry, so a site problem never wipes
 * facts. A model that left the provider's list is removed.
 *
 * `listedIds` are what the provider's list names (a model id, or for Anthropic a page name); `sourceFor` gives each one's
 * page, which is how an old entry is found again when its page cannot be read this time.
 */
export function mergeProviderProfiles(oldEntries, provider, readings, listedIds, sourceFor, now) {
  const old = new Map(oldEntries.filter((entry) => entry.provider === provider).map((entry) => [entry.modelId, entry]));
  const bySource = new Map([...old.values()].map((entry) => [entry.provenance.source, entry]));
  const next = [];
  const report = { updated: [], unchanged: [], kept: [], removed: [] };
  for (const listedId of listedIds) {
    const reading = readings.get(listedId);
    const previous = bySource.get(sourceFor(listedId)) ?? old.get(listedId);
    const modelId = previous?.modelId ?? listedId;
    if (reading?.kind === "profile") {
      const entryId = reading.modelId ?? listedId;
      const prior = old.get(entryId) ?? previous;
      if (prior && sameProfile(prior.profile, reading.profile) && prior.provenance.source === reading.source) {
        next.push(prior);
        report.unchanged.push(entryId);
      } else {
        next.push({ provider, modelId: entryId, profile: reading.profile, provenance: { source: reading.source, readAt: now } });
        report.updated.push(entryId);
      }
    } else if (previous) {
      next.push(previous);
      report.kept.push({ modelId, reason: reading?.reason ?? "not read" });
    }
  }
  const nextIds = new Set(next.map((entry) => entry.modelId));
  for (const modelId of old.keys()) if (!nextIds.has(modelId)) report.removed.push(modelId);
  const unique = [...new Map(next.map((entry) => [entry.modelId, entry])).values()];
  return { entries: unique, report };
}
