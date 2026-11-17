/**
 * What Anthropic says about one model on its documentation site. The models overview links each model's page
 * (`/docs/en/models/<slug>/overview`), and every page has a Markdown copy at `<page>.md`:
 *   - a status line such as "**Latest.** Released …" or "**Legacy.** Released …";
 *   - for a current model, a line saying what it is for; for a legacy one, a note about moving to a newer model;
 *   - "Model ID: `…`" and a line with the context window, maximum output and prices;
 *   - an "Overview" paragraph, and a comparison table whose "(this model)" row gives its latency (relative to the
 *     current lineup), thinking and knowledge cutoff.
 */
import { firstParagraph, limitText, plainText, readCount, readDollars, section, tableRows } from "./markdown.mjs";

const ORIGIN = "https://platform.claude.com";
export const ANTHROPIC_MODEL_LIST_URL = `${ORIGIN}/docs/en/about-claude/models/overview.md`;
const PAGE_LINK = /\/docs\/en\/models\/([a-z0-9][a-z0-9-]*)\/overview/g;
const LATENCY = new Map([["fastest", "fastest"], ["fast", "fast"], ["moderate", "moderate"], ["slow", "slow"], ["slowest", "slowest"]]);

export function anthropicModelPageUrl(slug) {
  return `${ORIGIN}/docs/en/models/${encodeURIComponent(slug)}/overview`;
}

/** The page slugs the overview links to. */
export async function listAnthropicModelPages(fetchImpl, timeoutMs) {
  const response = await fetchImpl(ANTHROPIC_MODEL_LIST_URL, { headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Anthropic models overview answered HTTP ${response.status}`);
  const markdown = await response.text();
  return [...new Set([...markdown.matchAll(PAGE_LINK)].map((match) => match[1]))].sort();
}

/** The comparison table under any heading starting "How it compares", as objects keyed by lowercase column name. */
function comparisonRow(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+How it compares/i.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const rows = tableRows(lines.slice(start + 1, end < 0 ? undefined : end));
  if (rows.length < 2) return null;
  const header = rows[0].map((cell) => cell.toLowerCase());
  const own = rows.find((row) => /\(this model\)/i.test(row[0]));
  return own ? Object.fromEntries(header.map((name, index) => [name, own[index]])) : null;
}

/** `{ modelId, profile }` for one page, or null when the page names no model id. */
export function readAnthropicPageProfile(markdown) {
  const body = markdown.replace(/^---[\s\S]*?\n---\s*/, "");
  const lines = body.split(/\r?\n/);
  const modelId = /^Model ID:\s*`([^`]+)`/m.exec(body)?.[1];
  if (!modelId) return null;
  const statusLine = lines.find((line) => /^\*\*[A-Za-z]+\.\*\*/.test(line.trim())) ?? "";
  const statusWord = /^\*\*([A-Za-z]+)\.\*\*/.exec(statusLine.trim())?.[1].toLowerCase();
  const idLine = lines.findIndex((line) => /^Model ID:/.test(line.trim()));
  const statusIndex = lines.indexOf(statusLine);
  const lead = firstParagraph(lines.slice(statusIndex >= 0 ? statusIndex + 1 : 0, idLine));
  const limits = lines.find((line) => /^Context window:/i.test(line.trim())) ?? "";
  const parts = Object.fromEntries(limits.split("·").map((part) => part.split(":").map((text) => text.trim())).filter((pair) => pair.length >= 2).map(([key, ...rest]) => [key.toLowerCase(), rest.join(":")]));
  const row = comparisonRow(body);
  const latency = row?.latency ? LATENCY.get(row.latency.toLowerCase()) : undefined;
  const current = statusWord === "latest";
  const profile = {
    name: plainText(/^title:\s*(.*)$/m.exec(markdown)?.[1]?.replace(/^"|"$/g, "")) || undefined,
    summary: current ? limitText(lead, 300) : undefined,
    description: limitText(firstParagraph(section(body, "Overview")), 600),
    contextWindow: readCount(parts["context window"]),
    maxOutputTokens: readCount(parts["max output"]),
    price: readDollars(parts["input pricing"]) !== undefined && readDollars(parts["output pricing"]) !== undefined
      ? { inputPerMillion: readDollars(parts["input pricing"]), outputPerMillion: readDollars(parts["output pricing"]) }
      : undefined,
    latency,
    knowledgeCutoff: row?.["knowledge cutoff"] || undefined,
    reasoning: row?.thinking ? true : undefined,
    lifecycle: statusWord
      ? { status: current ? "active" : statusWord, ...(current || !lead ? {} : { note: limitText(lead, 300) }) }
      : undefined,
  };
  return { modelId, profile: Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)) };
}

export async function readAnthropicProfile(fetchImpl, slug, timeoutMs) {
  const source = anthropicModelPageUrl(slug);
  try {
    const response = await fetchImpl(`${source}.md`, { headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const read = readAnthropicPageProfile(await response.text());
    return read ? { kind: "profile", source, modelId: read.modelId, profile: read.profile } : { kind: "failed", reason: "the page names no model id" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
