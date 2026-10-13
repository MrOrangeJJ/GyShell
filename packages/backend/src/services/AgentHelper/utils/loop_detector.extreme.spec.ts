import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROSE_CYCLE_THRESHOLDS,
  STRUCTURED_CYCLE_THRESHOLDS,
  StreamCycleDetector,
  collapseRepeatedToolCalls,
  findRepeatedToolCall,
  findSuffixCycle,
  toolCallKey,
  type CycleThresholds,
  type StreamCycleHit,
} from "./loop_detector";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

/** Deterministic PRNG so every run streams the same chunk boundaries. */
const createRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type ChunkPlan = { label: string; next: () => number };

const chunkPlans = (seed: number): ChunkPlan[] => {
  const random = createRandom(seed);
  return [
    { label: "1-char", next: () => 1 },
    { label: "7-char", next: () => 7 },
    { label: "64-char", next: () => 64 },
    { label: "300-char", next: () => 300 },
    { label: "random 1-40", next: () => 1 + Math.floor(random() * 40) },
    { label: "random 1-600", next: () => 1 + Math.floor(random() * 600) },
  ];
};

interface StreamResult {
  hit: StreamCycleHit | null;
  /** Characters fed when the detector tripped (or the full length). */
  fedChars: number;
}

const streamThrough = (
  text: string,
  detector: StreamCycleDetector,
  nextChunk: () => number,
): StreamResult => {
  let offset = 0;
  while (offset < text.length) {
    const size = Math.max(1, nextChunk());
    const delta = text.slice(offset, offset + size);
    offset += delta.length;
    const hit = detector.push(delta);
    if (hit) return { hit, fedChars: offset };
  }
  const hit = detector.flush();
  return { hit, fedChars: text.length };
};

const proseDetector = () =>
  new StreamCycleDetector(PROSE_CYCLE_THRESHOLDS, { markdownAware: true });
const toolArgumentDetector = () =>
  new StreamCycleDetector(STRUCTURED_CYCLE_THRESHOLDS);

const repeatToLength = (unit: string, length: number): string =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

const NOISE_PREFIX =
  "Let me look at the configuration first. The settings file lives under the user data directory, and the loader merges defaults before validation.\n\n";

interface PositiveCase {
  name: string;
  prefix: string;
  unit: string;
  /** Loop length streamed after the prefix. */
  loopChars: number;
  detector: () => StreamCycleDetector;
  thresholds: CycleThresholds;
}

/** Latest point where a loop of `unit` must trip, relative to its start. */
const maxTripLatency = (unit: string, thresholds: CycleThresholds): number => {
  const short = unit.length <= thresholds.shortMaxUnit;
  const copies = short ? thresholds.shortMinCopies : thresholds.longMinCopies;
  const minChars = short ? thresholds.shortMinChars : thresholds.longMinChars;
  const hasLetter = /\p{L}|\p{Extended_Pictographic}/u.test(unit);
  let required = Math.max(copies * unit.length, minChars);
  if (!hasLetter) required = Math.max(required, thresholds.symbolOnlyMinChars);
  // A trip needs whole copies, then waits for the next scan (up to one
  // stride, or one oversized chunk of at most 600 chars in these plans).
  const wholeCopies = Math.ceil(required / unit.length) * unit.length;
  return wholeCopies + Math.max(thresholds.scanStride, 600) + unit.length;
};

const paragraph = (seed: number, words: number): string => {
  const random = createRandom(seed);
  const vocabulary =
    "the agent should inspect terminal output before deciding whether to retry install verify configure compile deploy package module service request response context history file directory process signal window buffer".split(
      " ",
    );
  const parts: string[] = [];
  for (let i = 0; i < words; i += 1) {
    parts.push(vocabulary[Math.floor(random() * vocabulary.length)]);
  }
  return `${parts.join(" ")}.\n`;
};

const positiveCases = (): PositiveCase[] => {
  const prose = { detector: proseDetector, thresholds: PROSE_CYCLE_THRESHOLDS };
  return [
    { name: "abcabc", prefix: NOISE_PREFIX, unit: "abc", loopChars: 1200, ...prose },
    { name: "aabccaabcc", prefix: NOISE_PREFIX, unit: "aabcc", loopChars: 1200, ...prose },
    { name: "single letter", prefix: NOISE_PREFIX, unit: "a", loopChars: 1200, ...prose },
    {
      name: "multi-line aaa/bbb/ddd",
      prefix: NOISE_PREFIX,
      unit: "aaa\nbbb\nddd\n",
      loopChars: 1200,
      ...prose,
    },
    {
      name: "repeated sentence",
      prefix: NOISE_PREFIX,
      unit: "I will check the file again to make sure. ",
      loopChars: 1500,
      ...prose,
    },
    {
      name: "repeated markdown bullet",
      prefix: "## Plan\n\n",
      unit: "- Verify the installation by running the tests.\n",
      loopChars: 1500,
      ...prose,
    },
    {
      name: "CJK sentence",
      prefix: "我先看一下配置文件。\n",
      unit: "我需要再检查一下这个文件，确认没有问题。",
      loopChars: 1500,
      ...prose,
    },
    { name: "emoji", prefix: NOISE_PREFIX, unit: "🙂", loopChars: 1200, ...prose },
    {
      name: "61-char unit (long rule)",
      prefix: NOISE_PREFIX,
      unit: `${"x".repeat(55)}-tail\n`,
      loopChars: 4000,
      ...prose,
    },
    {
      name: "500-char paragraph",
      prefix: NOISE_PREFIX,
      unit: paragraph(11, 80).slice(0, 499) + "\n",
      loopChars: 4000,
      ...prose,
    },
    {
      name: "1900-char paragraph",
      prefix: NOISE_PREFIX,
      unit: paragraph(12, 320).slice(0, 1899) + "\n",
      loopChars: 7600,
      ...prose,
    },
    {
      name: "symbol-only ?!",
      prefix: NOISE_PREFIX,
      unit: "?!",
      loopChars: 3200,
      ...prose,
    },
    {
      name: "digit-only counter text",
      prefix: NOISE_PREFIX,
      unit: "0123456789",
      loopChars: 3200,
      ...prose,
    },
    {
      name: "newline flood",
      prefix: NOISE_PREFIX,
      unit: "\n",
      loopChars: 3200,
      ...prose,
    },
    {
      name: "repeated whole code blocks with prose",
      prefix: NOISE_PREFIX,
      unit: "Here is the fix:\n```ts\nconst value = load();\n```\n",
      loopChars: 2000,
      ...prose,
    },
    {
      name: "loop inside an open code fence",
      prefix: `${NOISE_PREFIX}\`\`\`python\n`,
      unit: "def handler(event):\n    return process(event)\n\n",
      loopChars: 4000,
      detector: proseDetector,
      thresholds: STRUCTURED_CYCLE_THRESHOLDS,
    },
    {
      name: "tool arguments: repeated JSON object",
      prefix: '{"path":"/tmp/a.json","content":"[',
      unit: '{\\"id\\":1,\\"name\\":\\"same\\"},',
      loopChars: 4000,
      detector: toolArgumentDetector,
      thresholds: STRUCTURED_CYCLE_THRESHOLDS,
    },
    {
      name: "tool arguments: repeated file line",
      prefix: '{"path":"/tmp/a.py","content":"',
      unit: "print('hello world')\\n",
      loopChars: 4000,
      detector: toolArgumentDetector,
      thresholds: STRUCTURED_CYCLE_THRESHOLDS,
    },
  ];
};

const run = (): void => {
  runCase("suffix cycle: smallest period wins and counts copies", () => {
    const cycle = findSuffixCycle("xyz" + "ab".repeat(200), PROSE_CYCLE_THRESHOLDS);
    assertEqual(cycle?.unitLength, 2, "period of abab… is 2, not 4/6/…");
    assertEqual(cycle?.copies, 200, "every back-to-back copy is counted");
    const nested = findSuffixCycle(
      "aabcc".repeat(60),
      PROSE_CYCLE_THRESHOLDS,
    );
    assertEqual(nested?.unitLength, 5, "aabcc has period 5");
  });

  runCase("suffix cycle: below-threshold repetition is ignored", () => {
    assertEqual(
      findSuffixCycle("abc".repeat(59), PROSE_CYCLE_THRESHOLDS),
      null,
      "177 chars of abc is under the 180-char minimum",
    );
    assertEqual(
      findSuffixCycle("ab".repeat(90), PROSE_CYCLE_THRESHOLDS)?.unitLength,
      2,
      "180 chars of ab reaches the minimum",
    );
    const long = `${"y".repeat(99)}\n`;
    assertEqual(
      findSuffixCycle(NOISE_PREFIX + long.repeat(10), PROSE_CYCLE_THRESHOLDS),
      null,
      "10 copies of a 100-char unit is 1000 chars, under the long-unit 1024",
    );
  });

  for (const testCase of positiveCases()) {
    runCase(`positive: ${testCase.name} trips at every chunking`, () => {
      const loop = repeatToLength(testCase.unit, testCase.loopChars);
      const text = testCase.prefix + loop;
      const latency = maxTripLatency(testCase.unit, testCase.thresholds);
      for (const plan of chunkPlans(testCase.name.length)) {
        const { hit, fedChars } = streamThrough(
          text,
          testCase.detector(),
          plan.next,
        );
        assertCondition(hit, `${plan.label}: loop was not detected`);
        assertEqual(
          testCase.unit.length % hit!.unitLength,
          0,
          `${plan.label}: reported period must divide the unit`,
        );
        assertCondition(
          fedChars - testCase.prefix.length <= latency,
          `${plan.label}: tripped late (${fedChars - testCase.prefix.length} > ${latency} chars into the loop)`,
        );
        // The reported start is exact: everything from it on is periodic,
        // and the character before it (when inside the window) breaks the
        // period. It never lies after the real loop start.
        const start = hit!.repeatStartOffset;
        const period = hit!.unitLength;
        assertCondition(
          start <= testCase.prefix.length,
          `${plan.label}: loop start ${start} is after the real start ${testCase.prefix.length}`,
        );
        for (let i = start; i + period < fedChars; i += 1) {
          if (text[i] !== text[i + period]) {
            throw new Error(`${plan.label}: text is not periodic from ${start}`);
          }
        }
        const windowStart = fedChars - testCase.thresholds.windowChars;
        assertCondition(
          start === 0 ||
            start <= windowStart ||
            text[start - 1] !== text[start - 1 + period],
          `${plan.label}: loop start ${start} is not the maximal periodic start`,
        );
      }
    });
  }

  runCase("negative: ordinary structured output stays silent", () => {
    const rows = Array.from(
      { length: 200 },
      (_, i) => `| ${i} | service-${i} | ${(i * 37) % 101}ms | ok |\n`,
    ).join("");
    const json = JSON.stringify(
      Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}`, ok: true })),
      null,
      2,
    );
    const samples: Array<[string, string]> = [
      ["markdown table", `| id | name | latency | status |\n|---|---|---|---|\n${rows}`],
      ["json listing in a fence", `Results:\n\`\`\`json\n${json}\n\`\`\`\n`],
      ["horizontal rules", `${"=".repeat(80)}\nTitle\n${"=".repeat(80)}\n${"-".repeat(120)}\n`],
      ["short laugh", "hahahahahahahahaha, that was a funny bug.\n"],
      [
        "identical closing braces in a fence",
        `\`\`\`ts\n${"    }\n".repeat(12)}\`\`\`\n`,
      ],
      [
        "box drawing banner",
        `${"─".repeat(200)}\n│ Build finished │\n${"─".repeat(200)}\n`,
      ],
    ];
    for (const [label, text] of samples) {
      for (const plan of chunkPlans(label.length)) {
        const { hit } = streamThrough(text, proseDetector(), plan.next);
        assertEqual(hit, null, `${label} (${plan.label}) must not trip`);
      }
    }
  });

  runCase("negative: repository docs and sources stream without a trip", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../..",
    );
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (["dist", "out", "build", "release", "coverage"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (/\.(md|ts|tsx|css|json)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(root, "docs"), 0);
    walk(path.join(root, "packages"), 0);
    const corpus = files.filter((file) => {
      const size = fs.statSync(file).size;
      return size > 0 && size < 400_000 && !file.endsWith("package-lock.json");
    });
    assertCondition(corpus.length > 200, `expected a real corpus, got ${corpus.length} files`);

    const random = createRandom(7);
    const falsePositives: string[] = [];
    let scannedChars = 0;
    const started = performance.now();
    for (const file of corpus) {
      const source = fs.readFileSync(file, "utf8");
      scannedChars += source.length * 2;
      const relative = path.relative(root, file);
      const asMarkdown = file.endsWith(".md")
        ? source
        : `Here is \`${path.basename(file)}\`:\n\n\`\`\`\n${source}\n\`\`\`\n`;
      const next = () => 1 + Math.floor(random() * 120);
      const prose = streamThrough(asMarkdown, proseDetector(), next).hit;
      if (prose) {
        falsePositives.push(`${relative} [assistant text] unit=${prose.unitLength} copies=${prose.copies}`);
      }
      const asArguments = JSON.stringify({ path: relative, content: source });
      const args = streamThrough(asArguments, toolArgumentDetector(), next).hit;
      if (args) {
        falsePositives.push(`${relative} [tool arguments] unit=${args.unitLength} copies=${args.copies}`);
      }
    }
    const elapsedMs = performance.now() - started;
    console.log(
      `  corpus: ${corpus.length} files, ${(scannedChars / 1e6).toFixed(1)}M chars streamed in ${elapsedMs.toFixed(0)}ms, ${falsePositives.length} trips`,
    );
    for (const entry of falsePositives) console.log(`  trip: ${entry}`);
    assertCondition(
      falsePositives.length <= Math.ceil(corpus.length * 0.002),
      `too many false positives on real files (${falsePositives.length})`,
    );
  });

  runCase("performance: a long non-looping stream is cheap", () => {
    const text = Array.from({ length: 4000 }, (_, i) => paragraph(i + 100, 40)).join("");
    const started = performance.now();
    const { hit } = streamThrough(text, proseDetector(), () => 12);
    const elapsedMs = performance.now() - started;
    assertEqual(hit, null, "random prose must not trip");
    console.log(
      `  ${(text.length / 1e6).toFixed(2)}M chars in 12-char deltas: ${elapsedMs.toFixed(0)}ms`,
    );
    assertCondition(elapsedMs < 4000, `scan too slow: ${elapsedMs}ms`);
  });

  runCase("known limit: a loop with a changing counter is not exact", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Attempt ${i}: retrying the request.\n`).join("");
    const { hit } = streamThrough(text, proseDetector(), () => 32);
    assertEqual(hit, null, "exact matching ignores loops that differ per copy");
  });

  runCase("tool call key ignores key order and intent", () => {
    const a = toolCallKey({ name: "read_file", args: { path: "/a", limit: 10, intent: "look" } });
    const b = toolCallKey({ name: "read_file", args: { limit: 10, path: "/a", intent: "again" } });
    const c = toolCallKey({ name: "read_file", args: '{"path":"/a","limit":10}' });
    const d = toolCallKey({ name: "read_file", args: { path: "/b", limit: 10 } });
    assertEqual(a, b, "argument order and intent must not change the key");
    assertEqual(a, c, "string arguments are parsed before keying");
    assertCondition(a !== d, "different arguments must differ");
    assertCondition(
      toolCallKey({ name: "x", args: { nested: { b: 1, a: [1, { d: 2, c: 3 }] } } }) ===
        toolCallKey({ name: "x", args: { nested: { a: [1, { c: 3, d: 2 }], b: 1 } } }),
      "nested objects are canonicalized too",
    );
  });

  runCase("repeated tool calls: two are allowed, three trip, collapse keeps order", () => {
    const call = (id: string, path: string) => ({ id, name: "read_file", args: { path } });
    assertEqual(findRepeatedToolCall([call("1", "/a"), call("2", "/a"), call("3", "/b")]), null, "two copies are allowed");
    const repeated = findRepeatedToolCall([call("1", "/a"), call("2", "/b"), call("3", "/a"), call("4", "/a")]);
    assertEqual(repeated?.copies, 3, "three identical calls trip");
    const collapsed = collapseRepeatedToolCalls([
      call("1", "/a"), call("2", "/b"), call("3", "/a"), call("4", "/b"), call("5", "/a"),
    ]);
    assertEqual(collapsed.map((entry) => entry.id).join(","), "1,2,4", "keeps one /a and both /b");
  });
};

run();
