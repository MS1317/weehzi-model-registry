/**
 * Reads NVIDIA model context sizes from NVIDIA's own catalog site, build.nvidia.com.
 *
 * NVIDIA's model list (https://integrate.api.nvidia.com/v1/models) names each model but states no size. The size is
 * published on the model's page. That page is a Next.js page: asked with the `RSC: 1` header, it answers with its
 * server data as rows instead of HTML. Two kinds of row matter:
 *   - `<id>:<JSON>` followed by a line end;
 *   - `<id>:T<length in bytes, hex>,<text>` with no line end, so it can only be skipped by its byte length.
 * The model's catalog record is `{ artifactName, attributes: { specifications: { contextLength } } }`.
 *
 * The page is a website, not a documented API. When NVIDIA changes it, this reader finds no record and reports
 * "no size"; it never guesses a number.
 */

export const NVIDIA_MODEL_LIST_URL = "https://integrate.api.nvidia.com/v1/models";
const PAGE_ORIGIN = "https://build.nvidia.com";
const DATA_ROWS_CONTENT_TYPE = "text/x-component";

const COLON = 0x3a;
const COMMA = 0x2c;
const LINE_END = 0x0a;
const TEXT_ROW_MARK = 0x54; // "T"

/** The model's page address. Each part of the id is encoded on its own, so the `/` between them stays a path. */
export function nvidiaModelPageUrl(modelId) {
  return `${PAGE_ORIGIN}/${modelId.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The size the page states for exactly this model, or null when the page did not answer with its data rows, has no
 * record for the model, or has records that disagree with each other.
 */
export function readNvidiaPageContextWindow(body, modelId, contentType) {
  if (!String(contentType ?? "").toLowerCase().includes(DATA_ROWS_CONTENT_TYPE)) return null;
  // NVIDIA model ids are `<publisher>/<name>`; the catalog record names the model by its `<name>` part.
  const artifactName = modelId.slice(modelId.lastIndexOf("/") + 1);
  const sizes = new Set();
  for (const value of readJsonRows(body)) collectContextLengths(value, artifactName, sizes);
  return sizes.size === 1 ? [...sizes][0] : null;
}

function readJsonRows(body) {
  const decoder = new TextDecoder();
  const values = [];
  let at = 0;
  while (at < body.length) {
    const colon = body.indexOf(COLON, at);
    if (colon < 0) break;
    if (body[colon + 1] === TEXT_ROW_MARK) {
      const comma = body.indexOf(COMMA, colon);
      const length = comma < 0 ? Number.NaN : Number.parseInt(decoder.decode(body.subarray(colon + 2, comma)), 16);
      if (!Number.isSafeInteger(length) || length < 0) break;
      at = comma + 1 + length;
      continue;
    }
    const end = body.indexOf(LINE_END, colon);
    const rowEnd = end < 0 ? body.length : end;
    try {
      values.push(JSON.parse(decoder.decode(body.subarray(colon + 1, rowEnd))));
    } catch {
      // Module, hint and error rows are not JSON; they carry no catalog data.
    }
    at = rowEnd + 1;
  }
  return values;
}

function collectContextLengths(value, artifactName, sizes) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectContextLengths(item, artifactName, sizes);
    return;
  }
  if (value.artifactName === artifactName) {
    const contextLength = value.attributes?.specifications?.contextLength;
    if (Number.isSafeInteger(contextLength) && contextLength > 0) sizes.add(contextLength);
  }
  for (const child of Object.values(value)) collectContextLengths(child, artifactName, sizes);
}

/** The exact model ids in NVIDIA's public model list. Throws when the list cannot be read. */
export async function listNvidiaModels(fetchImpl, timeoutMs) {
  const response = await fetchImpl(NVIDIA_MODEL_LIST_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`NVIDIA model list answered HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error("NVIDIA model list has no data array");
  const ids = body.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

/**
 * Reads one model's page. The result says what happened:
 * - `{ kind: "size", contextWindow }`: the page states one size for this exact model;
 * - `{ kind: "no_size" }`: the page answered with its data rows but states no size for this model;
 * - `{ kind: "failed", reason }`: the page could not be read (network, HTTP error, or not the data rows).
 */
export async function readNvidiaModelPage(fetchImpl, modelId, timeoutMs) {
  const url = nvidiaModelPageUrl(modelId);
  try {
    const response = await fetchImpl(url, { headers: { RSC: "1", Accept: DATA_ROWS_CONTENT_TYPE }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const contentType = response.headers.get("content-type");
    if (!String(contentType ?? "").toLowerCase().includes(DATA_ROWS_CONTENT_TYPE)) {
      return { kind: "failed", reason: `answered ${contentType ?? "no content type"} instead of data rows` };
    }
    const contextWindow = readNvidiaPageContextWindow(new Uint8Array(await response.arrayBuffer()), modelId, contentType);
    return contextWindow === null ? { kind: "no_size" } : { kind: "size", contextWindow };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
