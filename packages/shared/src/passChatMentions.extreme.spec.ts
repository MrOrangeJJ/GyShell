import assert from "node:assert/strict";
import {
  encodePassChatMentionToken,
  extractPassChatMentionReferences,
  parsePassChatMentionToken,
  renderPassChatMentionTokensAsText,
  replacePassChatMentionTokens,
} from "./passChatMentions";

let failures = 0;

const runCase = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
};

runCase("canonical tokens preserve opaque session identity byte-for-byte", () => {
  const sessionId = "  Session#::]🙂\n  ";
  const title = "Plan # ] ::\n🙂";
  const token = encodePassChatMentionToken(sessionId, title);

  assert.equal(typeof token, "string");
  assert.deepEqual(parsePassChatMentionToken(token), {
    sessionId,
    title,
    format: "canonical-v2",
  });
  assert.deepEqual(extractPassChatMentionReferences(`before ${token} after`), [
    { sessionId, title },
  ]);
  assert.equal(
    renderPassChatMentionTokensAsText(`before ${token} after`),
    `before @Pass Chat: ${title} after`,
  );
});

runCase("canonical encoding keeps distinct whitespace, case, and prototype ids", () => {
  const ids = [" session ", "session", "Session", "__proto__", "会话🙂"];
  const tokens = ids.map((id) => encodePassChatMentionToken(id, "Chat"));

  assert.ok(tokens.every((token): token is string => typeof token === "string"));
  assert.equal(new Set(tokens).size, ids.length);
  assert.deepEqual(
    tokens.map((token) => parsePassChatMentionToken(token)?.sessionId),
    ids,
  );
});

runCase("canonical encoder rejects malformed identity and title strings", () => {
  assert.equal(encodePassChatMentionToken("   ", "Chat"), undefined);
  assert.equal(encodePassChatMentionToken("session", "\ud800"), undefined);
  assert.equal(encodePassChatMentionToken("\ud800", "Chat"), undefined);
  assert.equal(parsePassChatMentionToken(null), undefined);
  assert.equal(parsePassChatMentionToken({}), undefined);
});

runCase("malformed canonical tokens never fall back to legacy parsing", () => {
  const malformedTokens = [
    "[MENTION_PASS_CHAT_V2:#gyshell-pair-v1:1:%41:1:x#]",
    "[MENTION_PASS_CHAT_V2:#gyshell-pair-v1:999:A:1:x#]",
    "[MENTION_PASS_CHAT_V2:#gyshell-pair-v1:1:%:1:x#]",
    "[MENTION_PASS_CHAT_V2:#gyshell-pair-v1:1:A:1:x:trailing#]",
    "[MENTION_PASS_CHAT_V2:#session-1##Legacy-looking title#]",
    "[MENTION_PASS_CHAT_V2:#broken#]",
  ];

  for (const token of malformedTokens) {
    assert.equal(parsePassChatMentionToken(token), undefined, token);
    assert.deepEqual(extractPassChatMentionReferences(token), [], token);
    assert.equal(renderPassChatMentionTokensAsText(token), token, token);
  }
});

runCase("legacy parsing remains limited to its unambiguous compatibility subset", () => {
  const valid = "[MENTION_PASS_CHAT:#session-1##Previous%20Chat#]";
  assert.deepEqual(parsePassChatMentionToken(valid), {
    sessionId: "session-1",
    title: "Previous Chat",
    format: "legacy",
  });
  assert.deepEqual(
    parsePassChatMentionToken("[MENTION_PASS_CHAT:#session-1#]"),
    { sessionId: "session-1", format: "legacy" },
  );

  for (const token of [
    "[MENTION_PASS_CHAT:#session#with-delimiter##Title#]",
    "[MENTION_PASS_CHAT:#   ##Title#]",
    "[MENTION_PASS_CHAT:#session##bad%ZZ#]",
    "[MENTION_PASS_CHAT:#session##bad\ud800#]",
  ]) {
    assert.equal(parsePassChatMentionToken(token), undefined, token);
    assert.deepEqual(extractPassChatMentionReferences(token), [], token);
    assert.equal(renderPassChatMentionTokensAsText(token), token, token);
  }
});

runCase("replacement only invokes the callback for validated tokens", () => {
  const canonical = encodePassChatMentionToken("  session#1  ", "Canonical")!;
  const malformed = "[MENTION_PASS_CHAT_V2:#broken#]";
  const legacy = "[MENTION_PASS_CHAT:#legacy##Legacy#]";
  const seen: string[] = [];

  const result = replacePassChatMentionTokens(
    `${canonical}|${malformed}|${legacy}`,
    ({ sessionId }) => {
      seen.push(sessionId);
      return `<${sessionId}>`;
    },
  );

  assert.deepEqual(seen, ["  session#1  ", "legacy"]);
  assert.equal(
    result,
    "<  session#1  >|[MENTION_PASS_CHAT_V2:#broken#]|<legacy>",
  );
});

if (failures > 0) {
  console.error(`${failures} pass-chat mention test(s) failed.`);
  process.exit(1);
}

console.log("All pass-chat mention extreme tests passed.");
