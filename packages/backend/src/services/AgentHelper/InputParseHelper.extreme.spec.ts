import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InputParseHelper } from "./InputParseHelper";
import {
  FILE_CONTENT_TAG,
  PASS_CHAT_HISTORY_TAG,
  PASS_CHAT_LOCAL_PATH_SCOPE,
} from "./prompts";
import type { ISkillRuntime } from "../runtimeContracts";
import type { TerminalService } from "../TerminalService";
import { encodePassChatMentionToken } from "@gyshell/shared";
import { encodeTerminalScopedFilePath } from "./terminalScopedFilePath";

function createSkillRuntime(): ISkillRuntime {
  return {
    async reload() {
      return [];
    },
    async getAll() {
      return [];
    },
    async getEnabledSkills() {
      return [];
    },
    async readSkillContentByName(name: string) {
      throw new Error(`Unexpected skill read: ${name}`);
    },
    async createSkill() {
      throw new Error("Unexpected skill create");
    },
  };
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function createTerminalService(): TerminalService {
  return {
    getAllTerminals() {
      return [];
    },
    getRecentOutput() {
      return "";
    },
    async statFile() {
      throw new Error("Unexpected terminal file stat");
    },
    async readFile() {
      throw new Error("Unexpected terminal file read");
    },
  } as unknown as TerminalService;
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runCase(
  "user paste mention remains plain text and does not read temp files",
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-input-parse-"),
    );
    try {
      const tempFile = path.join(tempDir, "paste.txt");
      await fs.writeFile(tempFile, "cached paste body", "utf8");

      const result = await InputParseHelper.parseAndEnrich(
        `before [MENTION_USER_PASTE:#${tempFile}##preview#] after`,
        createSkillRuntime(),
        createTerminalService(),
      );

      assert.equal(
        result.displayContent,
        `before [MENTION_USER_PASTE:#${tempFile}##preview#] after`,
      );
      assert.ok(!result.enrichedContent.includes(FILE_CONTENT_TAG));
      assert.ok(!result.enrichedContent.includes("cached paste body"));
      assert.ok(result.enrichedContent.includes("[MENTION_USER_PASTE:"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "file mention still injects small local text file content",
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-input-parse-"),
    );
    try {
      const tempFile = path.join(tempDir, "note.txt");
      await fs.writeFile(tempFile, "small file body", "utf8");

      const result = await InputParseHelper.parseAndEnrich(
        `read [MENTION_FILE:#${tempFile}#]`,
        createSkillRuntime(),
        createTerminalService(),
      );

      assert.ok(
        result.enrichedContent.includes(`${FILE_CONTENT_TAG}<${tempFile}>`),
      );
      assert.ok(result.enrichedContent.includes("small file body"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "terminal-scoped file dedup uses collision-safe opaque pairs",
  async () => {
    const reads: Array<{ terminalId: string; filePath: string }> = [];
    const contentByReference = new Map<string, string>([
      [JSON.stringify(["alpha", "beta::gamma"]), "first collision body"],
      [JSON.stringify(["alpha::beta", "gamma"]), "second collision body"],
    ]);
    const terminalService = {
      async statFile(terminalId: string, filePath: string) {
        reads.push({ terminalId, filePath });
        return {
          exists: contentByReference.has(JSON.stringify([terminalId, filePath])),
          isDirectory: false,
          size: 64,
        };
      },
      async readFile(terminalId: string, filePath: string) {
        return Buffer.from(
          contentByReference.get(JSON.stringify([terminalId, filePath])) || "",
          "utf8",
        );
      },
    } as unknown as TerminalService;
    const first = encodeTerminalScopedFilePath("alpha", "beta::gamma");
    const second = encodeTerminalScopedFilePath("alpha::beta", "gamma");

    const result = await InputParseHelper.parseAndEnrich(
      `[MENTION_FILE:#${first}#] [MENTION_FILE:#${second}#] [MENTION_FILE:#${first}#]`,
      createSkillRuntime(),
      terminalService,
    );

    assert.equal(reads.length, 2);
    assert.deepEqual(reads, [
      { terminalId: "alpha", filePath: "beta::gamma" },
      { terminalId: "alpha::beta", filePath: "gamma" },
    ]);
    assert.ok(result.enrichedContent.includes("first collision body"));
    assert.ok(result.enrichedContent.includes("second collision body"));
  },
);

await runCase(
  "terminal-scoped file dedup preserves whitespace case and Unicode identities",
  async () => {
    const terminalIds = [" A ", "A", "a", "终端🙂"];
    const reads: string[] = [];
    const terminalService = {
      async statFile(terminalId: string) {
        reads.push(terminalId);
        return { exists: true, isDirectory: false, size: 32 };
      },
      async readFile(terminalId: string) {
        return Buffer.from(`body:${terminalId}`, "utf8");
      },
    } as unknown as TerminalService;
    const mentions = terminalIds
      .map(
        (terminalId) =>
          `[MENTION_FILE:#${encodeTerminalScopedFilePath(terminalId, "/tmp/exact.txt")}#]`,
      )
      .join(" ");

    const result = await InputParseHelper.parseAndEnrich(
      mentions,
      createSkillRuntime(),
      terminalService,
    );

    assert.deepEqual(reads, terminalIds);
    terminalIds.forEach((terminalId) => {
      assert.ok(result.enrichedContent.includes(`body:${terminalId}`));
    });
  },
);

await runCase(
  "terminal-less file references deduplicate only exact normalized paths",
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-input-parse-"),
    );
    try {
      const tempFile = path.join(tempDir, "duplicate.txt");
      await fs.writeFile(tempFile, "single local body", "utf8");
      const result = await InputParseHelper.parseAndEnrich(
        `[MENTION_FILE:#${tempFile}#] [MENTION_FILE:#${tempFile}#]`,
        createSkillRuntime(),
        createTerminalService(),
      );

      assert.equal(
        countOccurrences(result.enrichedContent, "single local body"),
        1,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "canonical pass-chat mention preserves opaque identity and rejects malformed lookup candidates",
  async () => {
    const sessionId = "  Session#opaque::🙂  ";
    const title = "Canonical # title";
    const canonical = encodePassChatMentionToken(sessionId, title);
    assert.ok(canonical);
    const malformed = "[MENTION_PASS_CHAT_V2:#broken#]";
    const input = `before ${malformed} ${canonical} after`;
    let resolverCalls = 0;

    const result = await InputParseHelper.parseAndEnrich(
      input,
      createSkillRuntime(),
      createTerminalService(),
      {
        passChatMentionResolver: async (references) => {
          resolverCalls += 1;
          assert.deepEqual(references, [{ sessionId, title }]);
          return `${PASS_CHAT_HISTORY_TAG}canonical detail\n`;
        },
      },
    );

    assert.equal(resolverCalls, 1);
    assert.equal(result.displayContent, input);
    assert.ok(result.enrichedContent.includes("canonical detail"));
    assert.ok(result.enrichedContent.includes(malformed));
  },
);

await runCase(
  "pass-chat mention injects resolver detail without raw markdown content",
  async () => {
    const result = await InputParseHelper.parseAndEnrich(
      "continue from [MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
      createSkillRuntime(),
      createTerminalService(),
      {
        passChatMentionResolver: async (references) => {
          assert.deepEqual(references, [
            { sessionId: "session-1", title: "Previous Chat" },
          ]);
          return `${PASS_CHAT_HISTORY_TAG}Markdown Export Path: /tmp/gyshell-pass-chats/pass-chat.md\nLocal Path Scope: ${PASS_CHAT_LOCAL_PATH_SCOPE}\nRecommended read_file args: terminalId="local-1", filePath="/tmp/gyshell-pass-chats/pass-chat.md"\nInstruction: read the file if needed.\n\n`;
        },
      },
    );

    assert.equal(
      result.displayContent,
      "continue from [MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
    );
    assert.ok(result.enrichedContent.includes(PASS_CHAT_HISTORY_TAG));
    assert.ok(
      result.enrichedContent.includes(
        "Markdown Export Path: /tmp/gyshell-pass-chats/pass-chat.md",
      ),
    );
    assert.ok(result.enrichedContent.includes(PASS_CHAT_LOCAL_PATH_SCOPE));
    assert.ok(
      result.enrichedContent.includes(
        'Recommended read_file args: terminalId="local-1"',
      ),
    );
    assert.ok(
      result.enrichedContent.includes(
        "[MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
      ),
    );
  },
);
