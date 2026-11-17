/**
 * What Ollama says about one model of its cloud catalog. All three sources are public:
 *   - https://ollama.com/api/tags lists the cloud models;
 *   - POST https://ollama.com/api/show `{ model }` gives its capabilities ("tools", "thinking", "vision", …),
 *     parameter count and context length;
 *   - the library page https://ollama.com/library/<name> has the maker's one-line description in its
 *     `<meta name="description">`.
 * Models a person runs on their own PC are read by Weehzi itself through the same `/api/show`.
 */
import { limitText } from "./markdown.mjs";

const ORIGIN = "https://ollama.com";
export const OLLAMA_MODEL_LIST_URL = `${ORIGIN}/api/tags`;

export function ollamaLibraryPageUrl(modelId) {
  return `${ORIGIN}/library/${encodeURIComponent(modelId.split(":")[0])}`;
}

export async function listOllamaModels(fetchImpl, timeoutMs) {
  const response = await fetchImpl(OLLAMA_MODEL_LIST_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Ollama model list answered HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.models)) throw new Error("Ollama model list has no models array");
  return [...new Set(body.models.map((model) => model?.name).filter((name) => typeof name === "string" && name))].sort();
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** The profile facts in an `/api/show` answer and a library page. */
export function readOllamaProfile(show, html) {
  const capabilities = Array.isArray(show?.capabilities) ? show.capabilities.filter((item) => typeof item === "string") : [];
  const info = show?.model_info && typeof show.model_info === "object" ? show.model_info : {};
  const architecture = typeof info["general.architecture"] === "string" ? info["general.architecture"] : undefined;
  const parameterCount = Number(info["general.parameter_count"] ?? show?.details?.parameter_size);
  const context = architecture ? Number(info[`${architecture}.context_length`]) : Number.NaN;
  const description = /<meta name="description" content="([^"]*)"/.exec(html ?? "")?.[1];
  const profile = {
    summary: description ? limitText(decodeEntities(description).trim(), 300) : undefined,
    parameters: Number.isSafeInteger(parameterCount) && parameterCount > 0 ? parameterCount : undefined,
    contextWindow: Number.isSafeInteger(context) && context > 0 ? context : undefined,
    inputModalities: capabilities.length > 0 ? (capabilities.includes("vision") ? ["text", "image"] : ["text"]) : undefined,
    toolCalling: capabilities.length > 0 ? capabilities.includes("tools") : undefined,
    reasoning: capabilities.length > 0 ? capabilities.includes("thinking") : undefined,
    features: capabilities.length > 0 ? capabilities : undefined,
  };
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
}

export async function readOllamaModelProfile(fetchImpl, modelId, timeoutMs) {
  const source = ollamaLibraryPageUrl(modelId);
  try {
    const showResponse = await fetchImpl(`${ORIGIN}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!showResponse.ok) return { kind: "failed", reason: `show answered HTTP ${showResponse.status}` };
    const show = await showResponse.json();
    const pageResponse = await fetchImpl(source, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    const html = pageResponse.ok ? await pageResponse.text() : "";
    const profile = readOllamaProfile(show, html);
    return Object.keys(profile).length > 0 ? { kind: "profile", source, profile } : { kind: "failed", reason: "nothing stated" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
