/**
 * Small readers for the Markdown that providers publish about their models (OpenAI and Anthropic documentation pages
 * end in `.md`; NVIDIA's model card is Markdown inside its page data; Google's model list is Markdown with cards).
 *
 * They read the page's structure (headings, list items, table rows) and return the maker's own words unchanged apart
 * from Markdown marks. They never decide what a model is good at: that is Weehzi's job, from typed facts.
 */

/** Text without Markdown links, emphasis, inline code, HTML tags and extra spaces. */
export function plainText(markdown) {
  return String(markdown ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts text to at most `max` characters at a sentence or word end, so stored text stays readable. */
export function limitText(text, max) {
  if (!text) return undefined;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 0 ? word : max)}…`;
}

/** The lines of the section under the first heading (any level) whose text is exactly `title`, up to the next heading of that level or higher. */
export function section(markdown, title) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  let level = 0;
  const body = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (level === 0) {
      if (heading && plainText(heading[2]).toLowerCase() === title.toLowerCase()) level = heading[1].length;
      continue;
    }
    if (heading && heading[1].length <= level) break;
    body.push(line);
  }
  return level === 0 ? null : body;
}

/** The first paragraph of plain prose in some lines: not a heading, list, table, quote, tag or link line. */
export function firstParagraph(lines) {
  if (!lines) return undefined;
  const paragraph = [];
  for (const raw of lines) {
    const line = raw.trim();
    const prose = line && !/^(#|[-*+]\s|\d+\.\s|\||>|<|\{%|!\[|\[[^\]]*\]\([^)]*\)\s*(·|$))/.test(line);
    if (prose) paragraph.push(line);
    else if (paragraph.length > 0) break;
  }
  const text = plainText(paragraph.join(" "));
  return text || undefined;
}

/** The text of every list item in some lines. */
export function listItems(lines) {
  return (lines ?? []).map((line) => /^\s*[-*+]\s+(.*)$/.exec(line)?.[1]).filter(Boolean).map(plainText);
}

/** A table's rows as arrays of cell text, without the header separator row. */
export function tableRows(lines) {
  return (lines ?? [])
    .filter((line) => /^\s*\|/.test(line) && !/^\s*\|\s*:?-{2,}/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => plainText(cell)));
}

/** A number written with thousands separators and an optional K or M, such as "400,000", "1M" or "128K". */
export function readCount(text) {
  const match = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])?\b/i.exec(String(text ?? ""));
  if (!match) return undefined;
  const base = Number(match[1].replaceAll(",", ""));
  const scale = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase() ?? ""] ?? 1;
  const value = Math.round(base * scale);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A US-dollar amount such as "$0.75" or "From $0.10". */
export function readDollars(text) {
  const match = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(text ?? ""));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Input and output kinds named in a list such as "text, image", in lowercase, without duplicates. */
export function modalities(text) {
  // "Images" and "image" are the same kind; a plural "s" is dropped (not from words ending "ss").
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[,/+]|\band\b/)
    .map((word) => word.trim().replace(/([^s])s$/, "$1"))
    .filter(Boolean);
  return words.length > 0 ? [...new Set(words)] : undefined;
}
