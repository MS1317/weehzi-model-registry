/**
 * Reads OpenAI model context sizes from OpenAI's own documentation site, developers.openai.com.
 *
 * OpenAI's API model list needs a key and states no size. The documentation does both without a key:
 *   - https://developers.openai.com/api/docs/models/all links every model page, older ones included, as
 *     `href="/api/docs/models/<id>"`;
 *   - each model page states its limits in plain HTML, for example
 *     `<span data-catalogue-template="{count} context window"><span data-catalogue-slot="count">400,000</span>`.
 *
 * The site is not a documented API. When OpenAI changes it, this reader finds no size and reports "no size"; it never
 * guesses a number.
 */

const ORIGIN = "https://developers.openai.com";
export const OPENAI_MODEL_LIST_URL = `${ORIGIN}/api/docs/models/all`;
const MODEL_LINK = /href="\/api\/docs\/models\/([a-z0-9][a-z0-9._-]*)"/g;

/** The model's documentation page. */
export function openAiModelPageUrl(modelId) {
  return `${ORIGIN}/api/docs/models/${encodeURIComponent(modelId)}`;
}

/** Every number the page states for one catalogue template, such as "{count} context window". */
function slotValues(html, template) {
  const pattern = new RegExp(
    `data-catalogue-template="${template.replace(/[{}]/g, "\\$&")}"><span data-catalogue-slot="count">([0-9][0-9,]*)</span>`,
    "g",
  );
  const values = new Set();
  for (const match of html.matchAll(pattern)) {
    const value = Number(match[1].replaceAll(",", ""));
    if (Number.isSafeInteger(value) && value > 0) values.add(value);
  }
  return values;
}

/**
 * The limits one model page states: `{ contextWindow, maxOutputTokens? }`, or null when the page states no context
 * window or states more than one. A maximum output that is missing, repeated with different values, or larger than the
 * context window is left out.
 */
export function readOpenAiPageLimits(html) {
  const windows = slotValues(html, "{count} context window");
  if (windows.size !== 1) return null;
  const contextWindow = [...windows][0];
  const outputs = slotValues(html, "{count} max output tokens");
  const maxOutputTokens = outputs.size === 1 ? [...outputs][0] : undefined;
  return maxOutputTokens !== undefined && maxOutputTokens <= contextWindow ? { contextWindow, maxOutputTokens } : { contextWindow };
}

/** The model ids the "all models" page links to. Throws when the page cannot be read. */
export async function listOpenAiModels(fetchImpl, timeoutMs) {
  const response = await fetchImpl(OPENAI_MODEL_LIST_URL, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`OpenAI model list page answered HTTP ${response.status}`);
  const html = await response.text();
  const ids = [...html.matchAll(MODEL_LINK)].map((match) => match[1]).filter((id) => id !== "all");
  return [...new Set(ids)].sort();
}

/**
 * Reads one model page. The result says what happened:
 * - `{ kind: "size", contextWindow, maxOutputTokens? }`: the page states one context window;
 * - `{ kind: "no_size" }`: the page was read but states no context window (image, audio and embedding models);
 * - `{ kind: "failed", reason }`: the page could not be read.
 */
export async function readOpenAiModelPage(fetchImpl, modelId, timeoutMs) {
  try {
    const response = await fetchImpl(openAiModelPageUrl(modelId), { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const limits = readOpenAiPageLimits(await response.text());
    return limits ? { kind: "size", ...limits } : { kind: "no_size" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
