/**
 * What NVIDIA says about one model on its catalog site, build.nvidia.com.
 *
 * The page answers the `RSC: 1` request with data rows (see ../nvidia-build-catalog.mjs). Three parts matter:
 *   - the catalog record `{ artifactName, attributes: { specifications, modelCapability } }`: parameter count, context
 *     length, input and output kinds, and whether NVIDIA lists function calling, structured output and reasoning;
 *   - the artifact `{ name, displayName, shortDescription, labels }`: NVIDIA's one-line description and its own labels,
 *     such as "Agent", "Reasoning" or "Long Context" (labels with a ":" are site settings, not categories);
 *   - the model card, a Markdown text row: its "Description" and "Use Case" paragraphs, the maker's own words.
 */
import { nvidiaModelPageUrl, readPageRows } from "../nvidia-build-catalog.mjs";
import { firstParagraph, limitText, section } from "./markdown.mjs";

const DATA_ROWS = "text/x-component";

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function kinds(list) {
  if (!Array.isArray(list)) return undefined;
  const values = [...new Set(list.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase()))];
  return values.length > 0 ? values : undefined;
}

/** The profile facts the page states for exactly this model; an empty object when it states none. */
export function readNvidiaPageProfile(body, modelId) {
  const name = modelId.slice(modelId.lastIndexOf("/") + 1);
  const { values, texts } = readPageRows(body);
  let record;
  let artifact;
  for (const value of values) {
    walk(value, (node) => {
      if (node.artifactName === name && node.attributes?.specifications && !record) record = node.attributes;
      if (node.name === name && typeof node.shortDescription === "string" && !artifact) artifact = node;
    });
  }
  const card = texts.find((text) => section(text, "Use Case") || section(text, "Description")) ?? "";
  const specs = record?.specifications ?? {};
  const capability = record?.modelCapability ?? {};
  const labels = Array.isArray(artifact?.labels)
    ? [...new Set(artifact.labels.filter((label) => typeof label === "string" && label.trim() && !label.includes(":")).map((label) => label.trim()))]
    : [];
  const profile = {
    name: typeof artifact?.displayName === "string" ? limitText(artifact.displayName.trim(), 120) : undefined,
    summary: typeof artifact?.shortDescription === "string" ? limitText(artifact.shortDescription.trim(), 300) : undefined,
    purpose: limitText(firstParagraph(section(card, "Use Case")), 600),
    description: limitText(firstParagraph(section(card, "Description")), 600),
    labels: labels.length > 0 ? labels : undefined,
    parameters: positiveInt(specs.parameters),
    contextWindow: positiveInt(specs.contextLength),
    inputModalities: kinds(specs.inputModalities),
    outputModalities: kinds(specs.outputModalities),
    toolCalling: bool(capability.functionCalling),
    structuredOutput: bool(capability.structuredOutput),
    reasoning: bool(capability.reasoning),
  };
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
}

/** Reads one model's page: `{ kind: "profile", source, profile }` or `{ kind: "failed", reason }`. */
export async function readNvidiaProfile(fetchImpl, modelId, timeoutMs) {
  const source = nvidiaModelPageUrl(modelId);
  try {
    const response = await fetchImpl(source, { headers: { RSC: "1", Accept: DATA_ROWS }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    if (!String(response.headers.get("content-type") ?? "").toLowerCase().includes(DATA_ROWS)) return { kind: "failed", reason: "not the data rows" };
    const profile = readNvidiaPageProfile(new Uint8Array(await response.arrayBuffer()), modelId);
    return Object.keys(profile).length > 0 ? { kind: "profile", source, profile } : { kind: "failed", reason: "the page states nothing about this model" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
