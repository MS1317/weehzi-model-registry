import assert from "node:assert/strict";
import test from "node:test";
import { nvidiaModelPageUrl, readNvidiaPageContextWindow } from "./nvidia-build-catalog.mjs";
import { checkRegistry, isNvidiaPageEntry, mergeNvidiaEntries, nextRegistryVersion } from "./registry.mjs";

const encoder = new TextEncoder();
const ROWS = "text/x-component";
const NOW = new Date("2026-11-09T03:17:00.000Z");

function record(artifactName, contextLength) {
  return { artifactName, attributes: { specifications: contextLength === undefined ? {} : { contextLength } } };
}

/** A text row: `<id>:T<byte length in hex>,<text>` with no line end. */
function textRow(id, text) {
  return `${id}:T${encoder.encode(text).length.toString(16)},${text}`;
}

test("the page address keeps the slash between publisher and name and encodes each part", () => {
  assert.equal(nvidiaModelPageUrl("nvidia/nemotron-3.5-super-vl-120b-a12b"), "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b");
  assert.equal(nvidiaModelPageUrl("a b/c#d"), "https://build.nvidia.com/a%20b/c%23d");
});

test("the size is read past text rows that hold multibyte characters, module rows and a related model's record", () => {
  const body = encoder.encode([
    '0:I["module",[],""]\n',
    textRow("1", "Résumé — 模型 description: 1:{\"artifactName\":\"m\"}"),
    `2:${JSON.stringify(["$", "div", null, { children: [record("model-related", 8_192), record("model", 262_144)] }])}\n`,
  ].join(""));
  assert.equal(readNvidiaPageContextWindow(body, "nvidia/model", ROWS), 262_144);
});

test("no size is read from HTML, from a page without the record, or from records that disagree", () => {
  const one = encoder.encode(`0:${JSON.stringify(record("model", 131_072))}\n`);
  assert.equal(readNvidiaPageContextWindow(one, "nvidia/model", "text/html; charset=utf-8"), null);
  assert.equal(readNvidiaPageContextWindow(one, "nvidia/model", null), null);
  assert.equal(readNvidiaPageContextWindow(encoder.encode(`0:${JSON.stringify(record("model"))}\n`), "nvidia/model", ROWS), null);
  const disagree = encoder.encode(`0:${JSON.stringify([record("model", 1), record("model", 2)])}\n`);
  assert.equal(readNvidiaPageContextWindow(disagree, "nvidia/model", ROWS), null);
  const same = encoder.encode(`0:${JSON.stringify([record("model", 4_096), record("model", 4_096)])}\n`);
  assert.equal(readNvidiaPageContextWindow(same, "nvidia/model", ROWS), 4_096);
  assert.equal(readNvidiaPageContextWindow(encoder.encode("0:T999,cut off"), "nvidia/model", ROWS), null);
});

const openAiEntry = {
  provider: "openai",
  modelId: "gpt-5.4",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  aliases: ["gpt-5.4-2026-03-05"],
  provenance: { source: "https://developers.openai.com/api/docs/models/gpt-5.4", verifiedAt: "2026-08-02T03:47:00.000Z" },
};

function nvidiaEntry(modelId, contextWindow, verifiedAt = "2026-11-01T00:00:00.000Z") {
  return { provider: "nvidia", modelId, contextWindow, provenance: { source: nvidiaModelPageUrl(modelId), verifiedAt } };
}

function registry(entries, registryVersion = "2026-08-02.2") {
  return { schemaVersion: 1, registryVersion, generatedAt: "2026-08-02T03:47:00.000Z", entries };
}

test("a first run keeps the entries people wrote and adds NVIDIA sizes in model order", () => {
  const previous = registry([openAiEntry]);
  const readings = new Map([
    ["z/second", { kind: "size", contextWindow: 131_072 }],
    ["a/first", { kind: "size", contextWindow: 262_144 }],
    ["b/no-size", { kind: "no_size" }],
    ["c/failed", { kind: "failed", reason: "HTTP 503" }],
  ]);
  const { document, changed, report } = mergeNvidiaEntries(previous, ["a/first", "b/no-size", "c/failed", "z/second"], readings, NOW);
  assert.equal(changed, true);
  assert.deepEqual(document.entries, [openAiEntry, nvidiaEntry("a/first", 262_144, NOW.toISOString()), nvidiaEntry("z/second", 131_072, NOW.toISOString())]);
  assert.equal(document.registryVersion, "2026-11-09.1");
  assert.equal(document.generatedAt, NOW.toISOString());
  assert.deepEqual(report.added.map((item) => item.modelId), ["a/first", "z/second"]);
  assert.deepEqual(checkRegistry(document), []);
});

test("a day with the same sizes changes nothing, not even the dates", () => {
  const previous = registry([openAiEntry, nvidiaEntry("a/first", 262_144)], "2026-11-08.1");
  const { document, changed } = mergeNvidiaEntries(previous, ["a/first"], new Map([["a/first", { kind: "size", contextWindow: 262_144 }]]), NOW);
  assert.equal(changed, false);
  assert.equal(document, previous);
});

test("a new size replaces the old one and is dated now", () => {
  const previous = registry([nvidiaEntry("a/first", 131_072)], "2026-11-09.1");
  const { document, report } = mergeNvidiaEntries(previous, ["a/first"], new Map([["a/first", { kind: "size", contextWindow: 262_144 }]]), NOW);
  assert.deepEqual(document.entries, [nvidiaEntry("a/first", 262_144, NOW.toISOString())]);
  assert.equal(document.registryVersion, "2026-11-09.2");
  assert.deepEqual(report.changed, [{ modelId: "a/first", from: 131_072, to: 262_144 }]);
});

test("a page that fails or stops stating a size keeps the recorded value and reports it", () => {
  const previous = registry([nvidiaEntry("a/first", 262_144), nvidiaEntry("b/second", 131_072)]);
  const readings = new Map([["a/first", { kind: "failed", reason: "HTTP 503" }], ["b/second", { kind: "no_size" }]]);
  const { changed, report } = mergeNvidiaEntries(previous, ["a/first", "b/second"], readings, NOW);
  assert.equal(changed, false);
  assert.deepEqual(report.kept.map((item) => item.modelId), ["a/first", "b/second"]);
});

test("a model that left NVIDIA's list is removed", () => {
  const previous = registry([openAiEntry, nvidiaEntry("a/first", 262_144), nvidiaEntry("gone/model", 8_192)]);
  const { document, report } = mergeNvidiaEntries(previous, ["a/first"], new Map([["a/first", { kind: "size", contextWindow: 262_144 }]]), NOW);
  assert.deepEqual(document.entries.map((entry) => entry.modelId), ["gpt-5.4", "a/first"]);
  assert.deepEqual(report.removed, [{ modelId: "gone/model" }]);
});

test("a model a person already describes is never written a second time, and an id Weehzi refuses is skipped", () => {
  const byHand = { provider: "nvidia", modelId: "a/first", contextWindow: 1_000_000, provenance: { source: "https://docs.api.nvidia.com/a-first", verifiedAt: "2026-11-01T00:00:00.000Z" } };
  assert.equal(isNvidiaPageEntry(byHand), false);
  const previous = registry([byHand]);
  const readings = new Map([["a/first", { kind: "size", contextWindow: 262_144 }], ["bad id", { kind: "size", contextWindow: 4_096 }]]);
  const { document, changed, report } = mergeNvidiaEntries(previous, ["a/first", "bad id"], readings, NOW);
  assert.equal(changed, false);
  assert.deepEqual(document.entries, [byHand]);
  assert.deepEqual(report.skipped.map((item) => item.modelId), ["bad id"]);
});

test("the check finds what would make Weehzi refuse the file", () => {
  assert.deepEqual(checkRegistry(registry([openAiEntry])), []);
  assert.match(checkRegistry(registry([nvidiaEntry("a/first", 1), nvidiaEntry("a/first", 2)])).join("\n"), /already uses/);
  assert.match(checkRegistry(registry([{ ...openAiEntry, capabilities: {} }])).join("\n"), /does not allow/);
  assert.match(checkRegistry(registry([{ ...openAiEntry, contextWindow: 0 }])).join("\n"), /contextWindow/);
  assert.match(checkRegistry({ ...registry([]), extra: true }).join("\n"), /unknown top-level field/);
});

test("the version counts up within a day and starts at 1 on a new day", () => {
  assert.equal(nextRegistryVersion("2026-11-09.4", NOW), "2026-11-09.5");
  assert.equal(nextRegistryVersion("2026-08-02.2", NOW), "2026-11-09.1");
  assert.equal(nextRegistryVersion(undefined, NOW), "2026-11-09.1");
});
