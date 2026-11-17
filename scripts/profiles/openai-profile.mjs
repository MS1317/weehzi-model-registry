/**
 * What OpenAI says about one model on its documentation site. Every page has a Markdown copy at `<page>.md`:
 *   - a quote line under the title: OpenAI's one-line description ("Our strongest mini model yet for coding, …");
 *   - a first paragraph: the longer description;
 *   - "Model details": input and output kinds, context window, maximum output, knowledge cutoff, reasoning support;
 *   - "Text tokens" pricing table, and "Supported features" and "Supported tools" lists.
 * A deprecated model's page says "Status: Deprecated" under the model id.
 */
import { openAiModelPageUrl } from "../openai-docs-catalog.mjs";
import { firstParagraph, limitText, listItems, modalities, plainText, readCount, readDollars, section, tableRows } from "./markdown.mjs";

/** The quote lines (`> …`) at the top of the page, before the first heading after the title, without the site's own note. */
function quoteLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const quotes = [];
  let seenTitle = false;
  for (const line of lines) {
    if (/^#\s/.test(line)) {
      if (seenTitle) break;
      seenTitle = true;
      continue;
    }
    if (/^##\s/.test(line)) break;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) quotes.push(plainText(quote[1]));
  }
  // The first quote on every page points to llms.txt; it is the site's note, not about the model.
  return quotes.filter((text) => text && !/llms\.txt/.test(text));
}

/** The prose after the title and quotes, before "Model details", without the "Status: …" line. */
function intro(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Model ID:/.test(line.trim()));
  return firstParagraph(lines.slice(start >= 0 ? start + 1 : 1).filter((line) => !/^Status:/i.test(line.trim())));
}

/** The page's "Status: …" line, such as "Deprecated", in lowercase. */
function status(markdown) {
  return /^Status:\s*(.+)$/im.exec(markdown)?.[1].trim().toLowerCase();
}

function detail(items, pattern) {
  return items.find((item) => pattern.test(item));
}

export function readOpenAiPageProfile(markdown) {
  const quotes = quoteLines(markdown);
  const pageStatus = status(markdown);
  const deprecated = quotes.some((text) => /^deprecated\b/i.test(text)) || pageStatus === "deprecated";
  const summary = quotes.find((text) => !/^deprecated\b/i.test(text));
  const details = listItems(section(markdown, "Model details"));
  const input = detail(details, /^input modalities:/i);
  const output = detail(details, /^output modalities:/i);
  const context = detail(details, /context window$/i);
  const maxOutput = detail(details, /max output tokens$/i);
  const cutoff = detail(details, /knowledge cutoff$/i);
  const prices = tableRows(section(markdown, "Text tokens"));
  const inputPrice = readDollars(prices.find((row) => /^input$/i.test(row[0]))?.[1]);
  const outputPrice = readDollars(prices.find((row) => /^output$/i.test(row[0]))?.[1]);
  const features = listItems(section(markdown, "Supported features"));
  const tools = listItems(section(markdown, "Supported tools"));
  const profile = {
    name: plainText(/^#\s+(.*)$/m.exec(markdown)?.[1]) || undefined,
    summary: limitText(summary, 300),
    description: limitText(intro(markdown), 600),
    inputModalities: input ? modalities(input.replace(/^input modalities:/i, "")) : undefined,
    outputModalities: output ? modalities(output.replace(/^output modalities:/i, "")) : undefined,
    contextWindow: context ? readCount(context) : undefined,
    maxOutputTokens: maxOutput ? readCount(maxOutput) : undefined,
    knowledgeCutoff: cutoff ? cutoff.replace(/\s*knowledge cutoff$/i, "").trim() || undefined : undefined,
    reasoning: details.some((item) => /^reasoning token support$/i.test(item)) ? true : undefined,
    toolCalling: features.length > 0 ? features.includes("function_calling") : undefined,
    structuredOutput: features.length > 0 ? features.includes("structured_outputs") : undefined,
    features: [...new Set([...features, ...tools])].length > 0 ? [...new Set([...features, ...tools])] : undefined,
    price: inputPrice !== undefined && outputPrice !== undefined ? { inputPerMillion: inputPrice, outputPerMillion: outputPrice } : undefined,
    lifecycle: deprecated ? { status: "deprecated" } : undefined,
  };
  if (profile.maxOutputTokens !== undefined && profile.contextWindow !== undefined && profile.maxOutputTokens > profile.contextWindow) delete profile.maxOutputTokens;
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
}

export async function readOpenAiProfile(fetchImpl, modelId, timeoutMs) {
  const source = openAiModelPageUrl(modelId);
  try {
    const response = await fetchImpl(`${source}.md`, { headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    const profile = readOpenAiPageProfile(await response.text());
    return Object.keys(profile).length > 1 ? { kind: "profile", source, profile } : { kind: "failed", reason: "the page states nothing about this model" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
