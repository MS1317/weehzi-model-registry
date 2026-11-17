// Tests for the model profile readers and the profile file check. Run with: node --test scripts/profiles.test.mjs
// The pages below are trimmed copies of each site's real format as read on 2026-11-17.
import assert from "node:assert/strict";
import test from "node:test";
import { readOpenAiPageProfile } from "./profiles/openai-profile.mjs";
import { readAnthropicPageProfile } from "./profiles/anthropic-profile.mjs";
import { readGeminiPageProfile } from "./profiles/gemini-profile.mjs";
import { readOllamaProfile } from "./profiles/ollama-profile.mjs";
import { readNvidiaPageProfile } from "./profiles/nvidia-profile.mjs";
import { checkProfiles, mergeProviderProfiles } from "./profiles/profiles.mjs";

test("OpenAI: one-line description, details, price, features and deprecation", () => {
  const page = `# GPT-5 mini

> For the complete documentation index, see [llms.txt](/llms.txt).

> Strong intelligence for cost sensitive, low latency, high volume workloads

Model ID: \`gpt-5-mini\`

Status: Deprecated

GPT-5 mini is a faster, more cost-efficient version of GPT-5.

## Model details

- Input modalities: text, image
- Output modalities: text
- 400,000 context window
- 128,000 max output tokens
- May 31, 2024 knowledge cutoff
- Reasoning token support

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $0.25 | 1M tokens |
| Output | $2 | 1M tokens |

## Supported features

- function_calling
- structured_outputs

## Supported tools

- apply_patch
`;
  const profile = readOpenAiPageProfile(page);
  assert.equal(profile.summary, "Strong intelligence for cost sensitive, low latency, high volume workloads");
  assert.equal(profile.description, "GPT-5 mini is a faster, more cost-efficient version of GPT-5.");
  assert.deepEqual(profile.inputModalities, ["text", "image"]);
  assert.equal(profile.contextWindow, 400_000);
  assert.equal(profile.maxOutputTokens, 128_000);
  assert.equal(profile.knowledgeCutoff, "May 31, 2024");
  assert.equal(profile.reasoning, true);
  assert.equal(profile.toolCalling, true);
  assert.deepEqual(profile.price, { inputPerMillion: 0.25, outputPerMillion: 2 });
  assert.deepEqual(profile.features, ["function_calling", "structured_outputs", "apply_patch"]);
  assert.deepEqual(profile.lifecycle, { status: "deprecated" });
});

test("Anthropic: purpose, limits, price and latency of a current model; a legacy model gets a note instead", () => {
  const current = `---
title: Claude Haiku 5.5
---

**Latest.** Released October 7, 2026.

For high-volume, latency-sensitive tasks such as classification, extraction, and routing

Model ID: \`claude-haiku-5-5\`

Context window: 1M tokens · Max output: 128K tokens · Input pricing: From $0.10 / MTok · Output pricing: From $0.50 / MTok

## Overview

Claude Haiku 5.5 is built for high-volume work.

## How it compares

| Model | Context | Latency | Thinking | Knowledge cutoff |
| :--- | :--- | :--- | :--- | :--- |
| [Claude Opus 5.5](x) | 1M | Moderate | Adaptive | Jun 2026 |
| **Claude Haiku 5.5** (this model) | 1M | Fastest | Adaptive | Jun 2026 |
`;
  const read = readAnthropicPageProfile(current);
  assert.equal(read.modelId, "claude-haiku-5-5");
  assert.equal(read.profile.summary, "For high-volume, latency-sensitive tasks such as classification, extraction, and routing");
  assert.equal(read.profile.contextWindow, 1_000_000);
  assert.equal(read.profile.maxOutputTokens, 128_000);
  assert.deepEqual(read.profile.price, { inputPerMillion: 0.1, outputPerMillion: 0.5 });
  assert.equal(read.profile.latency, "fastest");
  assert.deepEqual(read.profile.lifecycle, { status: "active" });

  const legacy = current.replace("**Latest.**", "**Legacy.**").replace("For high-volume, latency-sensitive tasks such as classification, extraction, and routing", "You should consider migrating to a newer model.");
  const old = readAnthropicPageProfile(legacy);
  assert.equal(old.profile.summary, undefined);
  assert.deepEqual(old.profile.lifecycle, { status: "legacy", note: "You should consider migrating to a newer model." });
});

test("Gemini: description, data types, limits and the capability grid", () => {
  const page = `> ## AI Agent Context

# Gemini 4 Hydrogen

Gemini 4 Hydrogen (\`gemini-4-hydrogen\`) brings speed and efficiency for everyday coding.

  * \`gemini-4-hydrogen\`
  *     **Inputs** Text, Image, and PDF

    **Output** Text
  *     **Context window (unified input and output token limit)** 1,048,576

    **Max output** 65,536 (default synchronous)

  [**Function calling**](/docs/function-calling)

  {% badge type="supported" /%}

  [**Image generation**](/docs/image-generation)

  {% badge type="not-supported" /%}

  [**Thinking**](/docs/thinking)

  {% badge label=Supported (low, high) type="supported" /%}
`;
  const profile = readGeminiPageProfile(page, "gemini-4-hydrogen");
  assert.equal(profile.name, "Gemini 4 Hydrogen");
  assert.deepEqual(profile.inputModalities, ["text", "image", "pdf"]);
  assert.equal(profile.contextWindow, 1_048_576);
  assert.equal(profile.maxOutputTokens, 65_536);
  assert.equal(profile.toolCalling, true);
  assert.equal(profile.reasoning, true);
  assert.deepEqual(profile.features, ["function calling", "thinking"]);
  assert.deepEqual(readGeminiPageProfile(page, "another-model"), {}, "a page about a different model states nothing for this one");
});

test("Ollama: capabilities, parameter count, context and the library description", () => {
  const profile = readOllamaProfile(
    { capabilities: ["completion", "tools", "thinking"], model_info: { "general.architecture": "nemotron_h_moe", "general.parameter_count": 120_000_000_000, "nemotron_h_moe.context_length": 262_144 } },
    '<meta name="description" content="A 120B open MoE model &amp; more."/>',
  );
  assert.deepEqual(profile, {
    summary: "A 120B open MoE model & more.",
    parameters: 120_000_000_000,
    contextWindow: 262_144,
    inputModalities: ["text"],
    toolCalling: true,
    reasoning: true,
    features: ["completion", "tools", "thinking"],
  });
});

test("NVIDIA: specifications, capability flags, labels and the model card", () => {
  const card = "# Model\\n\\n## Description\\n\\nA compact model.\\n\\n### Use Case\\n\\nIntended for customization and post-training.\\n";
  const cardText = card.replace(/\\n/g, "\n");
  const artifact = { name: "bolt-e4b", displayName: "Bolt", shortDescription: "Compact text model.", labels: ["Agent", "nimType:endpoint:x"] };
  const record = { artifactName: "bolt-e4b", attributes: { specifications: { contextLength: 65_536, parameters: 8_000_000_000, inputModalities: ["Text"] }, modelCapability: { functionCalling: true, reasoning: true } } };
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(cardText);
  const body = new Uint8Array([
    ...encoder.encode(`1:${JSON.stringify(record)}\n`),
    ...encoder.encode(`2:${JSON.stringify({ initialState: { artifact } })}\n`),
    ...encoder.encode(`3:T${textBytes.length.toString(16)},`),
    ...textBytes,
  ]);
  const profile = readNvidiaPageProfile(body, "nvidia/bolt-e4b");
  assert.equal(profile.summary, "Compact text model.");
  assert.equal(profile.purpose, "Intended for customization and post-training.");
  assert.equal(profile.description, "A compact model.");
  assert.deepEqual(profile.labels, ["Agent"]);
  assert.equal(profile.parameters, 8_000_000_000);
  assert.equal(profile.contextWindow, 65_536);
  assert.deepEqual(profile.inputModalities, ["text"]);
  assert.equal(profile.toolCalling, true);
});

test("the file check refuses what Weehzi would refuse", () => {
  const valid = { schemaVersion: 1, generatedAt: "2026-11-17T00:00:00.000Z", entries: [{ provider: "nvidia", modelId: "a/b", profile: { parameters: 1 }, provenance: { source: "https://x", readAt: "2026-11-17T00:00:00.000Z" } }] };
  assert.deepEqual(checkProfiles(valid), []);
  assert.ok(checkProfiles({ ...valid, entries: [{ ...valid.entries[0], profile: { secret: "x" } }] }).some((error) => /unknown field "secret"/.test(error)));
  assert.ok(checkProfiles({ ...valid, entries: [{ ...valid.entries[0], profile: { latency: "instant" } }] }).length > 0);
  assert.ok(checkProfiles({ ...valid, entries: [valid.entries[0], valid.entries[0]] }).some((error) => /repeats/.test(error)));
});

test("merging keeps a model whose page failed, drops one that left the list, and dates only real changes", () => {
  const source = (id) => `https://site/${id}`;
  const old = [
    { provider: "p", modelId: "kept", profile: { parameters: 1 }, provenance: { source: source("kept"), readAt: "2026-01-01T00:00:00.000Z" } },
    { provider: "p", modelId: "same", profile: { parameters: 2 }, provenance: { source: source("same"), readAt: "2026-01-01T00:00:00.000Z" } },
    { provider: "p", modelId: "gone", profile: { parameters: 3 }, provenance: { source: source("gone"), readAt: "2026-01-01T00:00:00.000Z" } },
  ];
  const readings = new Map([
    ["kept", { kind: "failed", reason: "HTTP 500" }],
    ["same", { kind: "profile", source: source("same"), profile: { parameters: 2 } }],
    ["new", { kind: "profile", source: source("new"), profile: { parameters: 4 } }],
  ]);
  const { entries, report } = mergeProviderProfiles(old, "p", readings, ["kept", "same", "new"], source, "2026-11-17T00:00:00.000Z");
  assert.deepEqual(entries.map((entry) => entry.modelId), ["kept", "same", "new"]);
  assert.equal(entries[1].provenance.readAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entries[2].provenance.readAt, "2026-11-17T00:00:00.000Z");
  assert.deepEqual(report.removed, ["gone"]);
  assert.deepEqual(report.kept, [{ modelId: "kept", reason: "HTTP 500" }]);
});
