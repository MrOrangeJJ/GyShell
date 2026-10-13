import assert from "node:assert/strict";
import {
  buildTerminalSessionTitleMaps,
  cleanTerminalSessionTitle,
  normalizeTerminalSessionTitle,
  resolveTerminalSessionTitle,
  TERMINAL_SESSION_TITLE_CHAR_LIMIT,
} from "./sessionTitleDisplay";

assert.equal(
  cleanTerminalSessionTitle(
    "[MENTION_SKILL:#ego-browser#] [MENTION_TAB:#Local##Local (1)#] @检查历史会话##run-42",
  ),
  "检查历史会话",
);

assert.equal(
  cleanTerminalSessionTitle("TuTu_ResPi是一台用于测试的远程机器"),
  "TuTu_ResPi",
);

assert.equal(
  cleanTerminalSessionTitle("[MENTION_TAB:#Local##Local (1)#] 真实标题"),
  "真实标题",
);

const longTitle = cleanTerminalSessionTitle("会话标题一二三四五六七八九十十一十二十三十四十五十六");
assert.equal(Array.from(longTitle).length, TERMINAL_SESSION_TITLE_CHAR_LIMIT);
assert.equal(longTitle.endsWith("…"), true);
const fullTitle = "这是一个应该在 Output inspector 中完整显示的历史 Chat 标题";
assert.equal(normalizeTerminalSessionTitle(fullTitle), fullTitle);
assert.equal(resolveTerminalSessionTitle(fullTitle), fullTitle);

assert.equal(cleanTerminalSessionTitle("   "), "");
assert.equal(cleanTerminalSessionTitle(undefined), "");
assert.equal(cleanTerminalSessionTitle("New Session"), "");
assert.equal(cleanTerminalSessionTitle("New Chat"), "");
assert.equal(cleanTerminalSessionTitle("Untitled"), "");
assert.equal(resolveTerminalSessionTitle(undefined), "Agent");
assert.equal(resolveTerminalSessionTitle("New Session"), "Agent");

const titleMaps = buildTerminalSessionTitleMaps(
  { closed: "Closed Chat", active: "stale historical title" },
  [{ id: "active", title: "Current Chat" }, { id: "without-title" }],
);
assert.equal(titleMaps.all.get("closed"), "Closed Chat");
assert.equal(titleMaps.all.get("active"), "Current Chat");
assert.equal(titleMaps.active.get("active"), "Current Chat");
assert.equal(titleMaps.active.has("closed"), false);
assert.equal(titleMaps.active.has("without-title"), false);

console.log("All terminal session title display extreme tests passed.");
