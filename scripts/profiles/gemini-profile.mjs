/**
 * What Google says about one Gemini model on its documentation site. The models page links each model's page
 * (`/docs/models/<id>`), and every page has a Markdown copy at `<page>.md`:
 *   - the first paragraph under the title: what the model is for;
 *   - a property table: "Model code", "Inputs" and "Output", the context window and maximum output;
 *   - a capability grid: each capability is a bold link followed by a badge whose `type` is "supported" or
 *     "not-supported" (function calling, thinking, structured outputs, code execution, computer use, …).
 */
import { firstParagraph, limitText, modalities, plainText, readCount } from "./markdown.mjs";

const ORIGIN = "https://aistudio.google.com";
export const GEMINI_MODEL_LIST_URL = `${ORIGIN}/docs/models.md`;
const PAGE_LINK = /\(\/docs\/models\/([a-z0-9][a-z0-9.-]*)\)|href="\/docs\/models\/([a-z0-9][a-z0-9.-]*)"/g;

export function geminiModelPageUrl(modelId) {
  return `${ORIGIN}/docs/models/${encodeURIComponent(modelId)}`;
}

export async function listGeminiModels(fetchImpl, timeoutMs) {
  const response = await fetchImpl(GEMINI_MODEL_LIST_URL, { headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Gemini models page answered HTTP ${response.status}`);
  const markdown = await response.text();
  return [...new Set([...markdown.matchAll(PAGE_LINK)].map((match) => match[1] ?? match[2]))].sort();
}

/** Every capability in the grid, as `name -> supported`. */
function capabilities(markdown) {
  const found = new Map();
  for (const match of markdown.matchAll(/\[\*\*([^*\]]+)\*\*\]\([^)]*\)\s*\{%\s*badge[^%]*type="(supported|not-supported)"/g)) {
    found.set(match[1].trim(), match[2] === "supported");
  }
  return found;
}

export function readGeminiPageProfile(markdown, modelId) {
  const withoutNotes = markdown.split(/\r?\n/).filter((line) => !/^>/.test(line));
  const titleIndex = withoutNotes.findIndex((line) => /^#\s/.test(line));
  const intro = firstParagraph(withoutNotes.slice(titleIndex + 1));
  const inputs = /\*\*Inputs\*\*\s*([^\n]+)/.exec(markdown)?.[1];
  const output = /\*\*Outputs?\*\*\s*([^\n]+)/.exec(markdown)?.[1];
  const context = /\*\*Context window[^*]*\*\*\s*([^\n]+)/i.exec(markdown)?.[1] ?? /\*\*Input token limit\*\*\s*([^\n]+)/i.exec(markdown)?.[1];
  const maxOutput = /\*\*(?:Max output|Output token limit)\*\*\s*([^\n]+)/i.exec(markdown)?.[1];
  const grid = capabilities(markdown);
  const has = (name) => (grid.has(name) ? grid.get(name) : undefined);
  const supported = [...grid].filter(([, on]) => on).map(([name]) => name.toLowerCase());
  const profile = {
    name: plainText(withoutNotes[titleIndex]?.replace(/^#\s+/, "")) || undefined,
    description: limitText(intro, 600),
    inputModalities: inputs ? modalities(plainText(inputs)) : undefined,
    outputModalities: output ? modalities(plainText(output)) : undefined,
    contextWindow: context ? readCount(plainText(context)) : undefined,
    maxOutputTokens: maxOutput ? readCount(plainText(maxOutput)) : undefined,
    toolCalling: has("Function calling"),
    reasoning: has("Thinking"),
    structuredOutput: has("Structured outputs"),
    features: supported.length > 0 ? supported : undefined,
  };
  if (profile.maxOutputTokens !== undefined && profile.contextWindow !== undefined && profile.maxOutputTokens > profile.contextWindow) delete profile.maxOutputTokens;
  // The page is about this model only when its property table names the same model code.
  if (!new RegExp(`\`${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``).test(markdown)) return {};
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
}

export async function readGeminiProfile(fetchImpl, modelId, timeoutMs) {
  const source = geminiModelPageUrl(modelId);
  try {
    const response = await fetchImpl(`${source}.md`, { headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const profile = readGeminiPageProfile(await response.text(), modelId);
    return Object.keys(profile).length > 1 ? { kind: "profile", source, profile } : { kind: "failed", reason: "the page states nothing about this model" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
