import React, {
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react-lite";
import { X } from "lucide-react";
import {
  encodePassChatMentionToken,
  parsePassChatMentionToken,
  readOpaqueNonBlankWellFormedString,
} from "@gyshell/shared";
import { AppStore } from "../../stores/AppStore";
import {
  createImagePreviewDataUrl,
  isRecognizedImageFile,
  resolveRichInputClipboardPaste,
  type ComposerDraft,
  type ComposerImageAttachment,
  type InputImageAttachment,
} from "../../lib/userInput";
import {
  admitFileSystemPanelDragPayload,
  encodeTerminalScopedFilePath,
  getFileMentionDisplayName,
  getNativeFilePathResolver,
  type FileSystemPanelDragPayload,
  resolveNativeFilePath,
} from "../../lib/filesystemDragDrop";
import {
  createImeCompositionTracker,
  disposeImeCompositionTracker,
  markImeCompositionEnd,
  markImeCompositionStart,
  shouldLetImeHandleKeyDown,
  shouldSuppressPostCompositionEnter,
} from "../../lib/imeComposition";
import {
  resolveActiveMenuItemScrollTop,
  resolveFloatingMenuPlacement,
} from "../../lib/menuPlacement";
import {
  MENTION_SUGGESTION_GAP,
  MENTION_SUGGESTION_MARGIN,
  resolveMentionSuggestionMenuDimensions,
  truncatePassChatSuggestionTitle,
  type MentionSuggestionMode,
} from "../../lib/mentionSuggestionPresentation";
import { truncateMentionDisplayText } from "../../lib/mentionDisplay";
import "./richInput.scss";

type DraftInputImageAttachment = InputImageAttachment & {
  id?: string;
  localFile?: File;
  previewUrl?: string;
};

export interface RichInputHandle {
  focus: () => void;
  getValue: () => string;
  setValue: (val: string) => void;
  getDraft: () => ComposerDraft;
  setDraft: (draft: {
    text?: string;
    images?: DraftInputImageAttachment[];
  }) => void;
  clear: () => void;
}

interface RichInputProps {
  store: AppStore;
  placeholder?: string;
  onSend: (draft: ComposerDraft) => void;
  onInput?: (draft: ComposerDraft) => void;
  disabled?: boolean;
}

type RichMentionItem = {
  type: "skill" | "terminal" | "file" | "pass-chat-spec" | "pass-chat";
  name: string;
  id?: string;
  preview?: string;
};

type StoredChatHistorySummary = {
  id: string;
  title: string;
  updatedAt: number;
  messagesCount: number;
  lastMessagePreview?: string;
};

type MentionSuggestionAnchorRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const MENTION_TOKEN_REGEX =
  /(\[MENTION_(?:(?:SKILL|TAB|FILE|IMAGE|PASS_CHAT):#.+?#(?:#.+?#)?|PASS_CHAT_V2:#[^#\r\n]+#)\])/g;

const toMentionSuggestionAnchorRect = (
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): MentionSuggestionAnchorRect => ({
  left: rect.left,
  top: rect.top,
  width: Math.max(1, rect.width),
  height: Math.max(1, rect.height),
});

const escapeHtml = (value: string): string =>
  String(value || "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });

const setMentionDisplayText = (span: HTMLElement, rawText: string): void => {
  span.textContent = truncateMentionDisplayText(rawText);
  span.title = rawText;
};

const getMentionTagClassName = (type: RichMentionItem["type"]): string => {
  if (type === "pass-chat-spec") return "mention-tag";
  return `mention-tag mention-${type}`;
};

const appendRestoredMentionToken = (
  editor: HTMLElement,
  token: string,
): boolean => {
  const skillMatch = token.match(/^\[MENTION_SKILL:#(.+?)#\]$/);
  if (skillMatch) {
    const span = document.createElement("span");
    span.className = getMentionTagClassName("skill");
    span.contentEditable = "false";
    span.dataset.type = "skill";
    span.dataset.name = skillMatch[1];
    setMentionDisplayText(span, `@${skillMatch[1]}`);
    editor.appendChild(span);
    return true;
  }

  const terminalMatch = token.match(
    /^\[MENTION_TAB:#(.+?)##(.+?)#\]$/,
  );
  if (terminalMatch) {
    const span = document.createElement("span");
    span.className = getMentionTagClassName("terminal");
    span.contentEditable = "false";
    span.dataset.type = "terminal";
    span.dataset.name = terminalMatch[1];
    span.dataset.id = terminalMatch[2];
    setMentionDisplayText(span, `@${terminalMatch[1]}`);
    editor.appendChild(span);
    return true;
  }

  const fileMatch = token.match(/^\[MENTION_FILE:#(.+?)#\]$/);
  if (fileMatch) {
    const span = document.createElement("span");
    span.className = getMentionTagClassName("file");
    span.contentEditable = "false";
    span.dataset.type = "file";
    span.dataset.name = fileMatch[1];
    setMentionDisplayText(
      span,
      getFileMentionDisplayName(fileMatch[1]) || fileMatch[1],
    );
    editor.appendChild(span);
    return true;
  }

  const imageMatch = token.match(
    /^\[MENTION_IMAGE:#(.+?)(?:##(.+?))?#\]$/,
  );
  if (imageMatch) {
    const span = document.createElement("span");
    span.className = getMentionTagClassName("file");
    span.contentEditable = "false";
    span.dataset.type = "file";
    span.dataset.name = imageMatch[1];
    setMentionDisplayText(
      span,
      imageMatch[2] ||
        getFileMentionDisplayName(imageMatch[1]) ||
        imageMatch[1],
    );
    editor.appendChild(span);
    return true;
  }

  const passChat = parsePassChatMentionToken(token);
  if (!passChat) return false;
  const span = document.createElement("span");
  span.className = getMentionTagClassName("pass-chat");
  span.contentEditable = "false";
  span.dataset.type = "pass-chat";
  span.dataset.id = passChat.sessionId;
  span.dataset.name = passChat.title || "Chat";
  setMentionDisplayText(span, `@Pass Chat: ${span.dataset.name}`);
  editor.appendChild(span);
  return true;
};

const restoreRichInputText = (editor: HTMLElement, value: string): void => {
  const parts = value.split(MENTION_TOKEN_REGEX);
  editor.innerHTML = "";
  for (const part of parts) {
    if (appendRestoredMentionToken(editor, part)) continue;
    if (!part) continue;
    editor.appendChild(
      document.createTextNode(
        part.replace(/\u00A0/g, " ").replace(/\uFEFF/g, ""),
      ),
    );
  }
};

export const RichInput = observer(
  forwardRef<RichInputHandle, RichInputProps>(
    ({ store, placeholder, onSend, onInput, disabled }, ref) => {
      const editorRef = useRef<HTMLDivElement>(null);
      const suggestionMenuRef = useRef<HTMLDivElement>(null);
      const suggestionItemRefs = useRef<Array<HTMLDivElement | null>>([]);
      const [showSuggestions, setShowSuggestions] = useState(false);
      const [suggestions, setSuggestions] = useState<RichMentionItem[]>([]);
      const [suggestionMode, setSuggestionMode] =
        useState<MentionSuggestionMode>("mention");
      const [passChatLoading, setPassChatLoading] = useState(false);
      const [passChatError, setPassChatError] = useState("");
      const [selectedIndex, setSelectedIndex] = useState(0);
      const [suggestionAnchorRect, setSuggestionAnchorRect] =
        useState<MentionSuggestionAnchorRect | null>(null);
      const [suggestionStyle, setSuggestionStyle] = useState<
        React.CSSProperties | undefined
      >(undefined);
      const [imageAttachments, setImageAttachments] = useState<
        ComposerImageAttachment[]
      >([]);
      const imageAttachmentsRef = useRef<ComposerImageAttachment[]>([]);
      const pendingMentionDeleteRef = useRef<HTMLElement | null>(null);
      const imeCompositionRef = useRef(createImeCompositionTracker());
      const passChatLoadRequestRef = useRef(0);
      const cursorMarker = "\uFEFF";

      const isBlobPreview = (url: string): boolean =>
        String(url || "").startsWith("blob:");

      const releasePreviewUrl = (url: string) => {
        if (!isBlobPreview(url)) return;
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revoke errors
        }
      };

      const normalizeAttachment = (
        input: DraftInputImageAttachment,
        fallbackId?: string,
      ): ComposerImageAttachment | null => {
        const attachmentId = String(input.attachmentId || "").trim();
        const localFile = (input as any).localFile;
        const hasLocalFile = localFile instanceof File;
        if (!attachmentId && !hasLocalFile) return null;
        const previewUrlInput = String((input as any).previewUrl || "").trim();
        const previewDataUrl = String(input.previewDataUrl || "").trim();
        const previewUrl =
          previewDataUrl ||
          previewUrlInput ||
          (hasLocalFile ? createPreviewUrlForLocalFile(localFile) : "");
        const fallbackName = hasLocalFile
          ? String(localFile.name || "").trim()
          : "";
        return {
          id:
            String((input as any).id || "").trim() ||
            fallbackId ||
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...(attachmentId ? { attachmentId } : {}),
          fileName:
            input.fileName ||
            fallbackName ||
            `image-${attachmentId || "local"}`,
          mimeType:
            input.mimeType ||
            (hasLocalFile ? localFile.type || undefined : undefined),
          sizeBytes:
            input.sizeBytes ??
            (hasLocalFile && Number.isFinite(localFile.size)
              ? localFile.size
              : undefined),
          sha256: input.sha256,
          ...(previewDataUrl ? { previewDataUrl } : {}),
          status: input.status,
          previewUrl,
          ...(hasLocalFile ? { localFile } : {}),
        };
      };

      const createPreviewUrlForLocalFile = (file: File): string =>
        URL.createObjectURL(file);

      const buildDraft = (): ComposerDraft => ({
        text: serialize(),
        images: imageAttachments,
      });

      const updateImageAttachments = (
        updater: (
          current: ComposerImageAttachment[],
        ) => ComposerImageAttachment[],
      ) => {
        setImageAttachments((current) => {
          const next = updater(current);
          const nextIds = new Set(next.map((item) => item.id));
          current.forEach((item) => {
            if (!nextIds.has(item.id)) {
              releasePreviewUrl(item.previewUrl);
            }
          });
          return next;
        });
      };

      const buildImageFromLocalFile = async (
        file: File,
      ): Promise<ComposerImageAttachment | null> => {
        if (!isRecognizedImageFile(file)) return null;
        let previewDataUrl = "";
        try {
          previewDataUrl = await createImagePreviewDataUrl(file);
        } catch {
          previewDataUrl = "";
        }
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fileName: file.name || "image",
          mimeType: file.type || undefined,
          sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
          ...(previewDataUrl ? { previewDataUrl } : {}),
          previewUrl: previewDataUrl || createPreviewUrlForLocalFile(file),
          localFile: file,
        };
      };

      const getMentionInfo = () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);

        if (!range.collapsed) return null;

        const textNode = range.startContainer;

        // Case 1: Cursor is in an element node (like the editor div)
        if (textNode.nodeType !== Node.TEXT_NODE) {
          const siblingBefore = textNode.childNodes[range.startOffset - 1];
          if (
            siblingBefore instanceof HTMLElement &&
            siblingBefore.classList.contains("mention-tag")
          ) {
            return {
              query: siblingBefore.dataset.name || "",
              index: 0,
              isReSelect: true,
              targetTag: siblingBefore,
            };
          }
          return null;
        }

        // Case 2: Cursor is in a text node
        const textBefore =
          textNode.textContent?.slice(0, range.startOffset) || "";

        // Check if we are at the beginning of a text node that follows a tag
        const siblingBefore = textNode.previousSibling;
        if (
          range.startOffset === 0 &&
          siblingBefore instanceof HTMLElement &&
          siblingBefore.classList.contains("mention-tag")
        ) {
          return {
            query: siblingBefore.dataset.name || "",
            index: 0,
            isReSelect: true,
            targetTag: siblingBefore,
          };
        }

        // If cursor is after one or more marker chars right after a mention tag, still treat as re-select.
        if (
          siblingBefore instanceof HTMLElement &&
          siblingBefore.classList.contains("mention-tag") &&
          textBefore.length > 0 &&
          new RegExp(`^${cursorMarker}+$`).test(textBefore)
        ) {
          return {
            query: siblingBefore.dataset.name || "",
            index: 0,
            isReSelect: true,
            targetTag: siblingBefore,
          };
        }

        const lastAtIdx = textBefore.lastIndexOf("@");
        if (lastAtIdx === -1) return null;

        return { query: textBefore.slice(lastAtIdx + 1), index: lastAtIdx };
      };

      const resolveSuggestionAnchorRect = useCallback(
        (
          info: ReturnType<typeof getMentionInfo>,
        ): MentionSuggestionAnchorRect | null => {
          const targetTag = (info as { targetTag?: unknown } | null)?.targetTag;
          if (targetTag instanceof HTMLElement) {
            return toMentionSuggestionAnchorRect(
              targetTag.getBoundingClientRect(),
            );
          }

          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0).cloneRange();
            const rects = range.getClientRects();
            const rect =
              rects.length > 0 ? rects[0] : range.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) {
              return toMentionSuggestionAnchorRect(rect);
            }
          }

          const editorRect = editorRef.current?.getBoundingClientRect();
          if (!editorRect) return null;
          return {
            left: editorRect.left + 8,
            top: editorRect.top,
            width: 1,
            height: Math.max(1, editorRect.height),
          };
        },
        [],
      );

      const recomputeSuggestionPlacement = useCallback(() => {
        const menu = suggestionMenuRef.current;
        const anchorRect = suggestionAnchorRect;
        if (!menu || !anchorRect) return;

        const dimensions = resolveMentionSuggestionMenuDimensions(
          suggestionMode,
          window.innerWidth,
          MENTION_SUGGESTION_MARGIN,
        );
        const measured = menu.getBoundingClientRect();
        const placement = resolveFloatingMenuPlacement({
          anchorRect,
          menuWidth: dimensions.width,
          menuHeight: Math.ceil(
            measured.height || dimensions.preferredMaxHeight,
          ),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          margin: MENTION_SUGGESTION_MARGIN,
          gap: MENTION_SUGGESTION_GAP,
          preferredMaxHeight: dimensions.preferredMaxHeight,
        });
        const nextWidth = Math.min(dimensions.width, placement.maxWidth);

        setSuggestionStyle((current) => {
          if (suggestionMode === "pass-chat" && current) {
            return current;
          }
          if (
            current?.top === placement.top &&
            current?.left === placement.left &&
            current?.maxHeight === placement.maxHeight &&
            current?.maxWidth === nextWidth &&
            current?.width === nextWidth
          ) {
            return current;
          }
          return {
            position: "fixed",
            top: placement.top,
            left: placement.left,
            width: nextWidth,
            maxHeight: placement.maxHeight,
            maxWidth: nextWidth,
            zIndex: 10000,
          };
        });
      }, [suggestionAnchorRect, suggestionMode]);

      const updateSuggestions = useCallback(() => {
        const info = getMentionInfo();
        if (!info) {
          setShowSuggestions(false);
          setSuggestionMode("mention");
          return;
        }

        const query = info.query.toLowerCase();

        // Only show enabled skills
        const enabledSkills = store.skills.filter(
          (s) => store.settings?.tools?.skills?.[s.name] !== false,
        );
        const skills = enabledSkills.map((s) => ({
          type: "skill" as const,
          name: s.name,
        }));
        const tabs = store.terminalTabs.map((t) => ({
          type: "terminal" as const,
          name: t.title,
          id: t.id,
        }));
        const passChatSpec: RichMentionItem = {
          type: "pass-chat-spec",
          name: "Pass Chat",
          preview: "Reference a chat history",
        };
        const shouldShowPassChatSpec =
          query.length === 0 ||
          "[spec] pass chat".includes(query) ||
          "pass chat".includes(query) ||
          "past chat".includes(query) ||
          "chat history".includes(query);

        const filtered = [
          ...(shouldShowPassChatSpec ? [passChatSpec] : []),
          ...skills,
          ...tabs,
        ]
          .filter(
            (item) =>
              item.type === "pass-chat-spec" ||
              item.name.toLowerCase().includes(query),
          )
          .sort((a, b) => {
            if (a.type === "pass-chat-spec" && b.type !== "pass-chat-spec")
              return -1;
            if (b.type === "pass-chat-spec" && a.type !== "pass-chat-spec")
              return 1;
            const aLower = a.name.toLowerCase();
            const bLower = b.name.toLowerCase();
            if (aLower === query && bLower !== query) return -1;
            if (bLower === query && aLower !== query) return 1;
            const aStarts = aLower.startsWith(query);
            const bStarts = bLower.startsWith(query);
            if (aStarts && !bStarts) return -1;
            if (bStarts && !aStarts) return 1;
            if (a.name.length !== b.name.length)
              return a.name.length - b.name.length;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 10);

        if (filtered.length > 0) {
          const anchorRect = resolveSuggestionAnchorRect(info);
          if (!anchorRect) {
            setShowSuggestions(false);
            return;
          }
          setSuggestions(filtered);
          setSuggestionMode("mention");
          setPassChatLoading(false);
          setPassChatError("");
          setSelectedIndex(0);
          setSuggestionAnchorRect(anchorRect);
          setSuggestionStyle(undefined);
          setShowSuggestions(true);
        } else {
          setShowSuggestions(false);
        }
      }, [
        resolveSuggestionAnchorRect,
        store.settings?.tools?.skills,
        store.skills,
        store.terminalTabs,
      ]);

      const formatPassChatMeta = (
        session: StoredChatHistorySummary,
      ): string => {
        const date = new Date(session.updatedAt || 0);
        const dateText = Number.isFinite(date.getTime())
          ? date.toLocaleString()
          : "Unknown time";
        return `${dateText} · ${session.messagesCount || 0} messages`;
      };

      const openPassChatPicker = async () => {
        const requestId = passChatLoadRequestRef.current + 1;
        passChatLoadRequestRef.current = requestId;
        setSuggestionMode("pass-chat");
        setPassChatLoading(true);
        setPassChatError("");
        setSuggestions([]);
        setSelectedIndex(0);
        setShowSuggestions(true);

        try {
          const history =
            (await store.chat.getAllChatHistory()) as StoredChatHistorySummary[];
          if (passChatLoadRequestRef.current !== requestId) return;
          const nextSuggestions = history.map((session) => {
            const sessionId = readOpaqueNonBlankWellFormedString(session?.id);
            if (sessionId === undefined) {
              throw new Error("Chat history returned an invalid session id.");
            }
            return {
              type: "pass-chat" as const,
              id: sessionId,
              name:
                String(session.title || "")
                  .replace(/\s+/g, " ")
                  .trim() || "Untitled Chat",
              preview: formatPassChatMeta(session),
            };
          });
          setSuggestions(nextSuggestions);
          setSelectedIndex(0);
        } catch (error) {
          if (passChatLoadRequestRef.current !== requestId) return;
          console.error(
            "Failed to load chat history for pass-chat mention:",
            error,
          );
          setPassChatError("Failed to load chat history");
          setSuggestions([]);
        } finally {
          if (passChatLoadRequestRef.current === requestId) {
            setPassChatLoading(false);
          }
        }
      };

      const buildMentionHtml = (item: RichMentionItem, uid: string): string => {
        const fileName = getFileMentionDisplayName(item.name) || item.name;
        const rawDisplayText =
          item.type === "file"
            ? item.preview || fileName
            : item.type === "pass-chat"
              ? `@Pass Chat: ${item.name}`
              : `@${item.name}`;
        const displayText = truncateMentionDisplayText(rawDisplayText);
        const attributes = [
          `class="${escapeHtml(getMentionTagClassName(item.type))}"`,
          `contenteditable="false"`,
          `title="${escapeHtml(rawDisplayText)}"`,
          `data-insert-id="${escapeHtml(uid)}"`,
          `data-type="${escapeHtml(item.type)}"`,
          `data-name="${escapeHtml(item.name)}"`,
          item.id ? `data-id="${escapeHtml(item.id)}"` : "",
          item.preview ? `data-preview="${escapeHtml(item.preview)}"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<span ${attributes}>${escapeHtml(displayText)}</span>${cursorMarker}`;
      };

      const setSelectionRange = (range: Range) => {
        const selection = window.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(range);
      };

      const createEditorEndRange = (): Range | null => {
        const editor = editorRef.current;
        if (!editor) return null;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        return range;
      };

      const placeCaretAfterInsertedTag = (tag: HTMLElement) => {
        const selection = window.getSelection();
        if (!selection) return;

        const range = document.createRange();
        const nextSibling = tag.nextSibling;
        if (nextSibling?.nodeType === Node.TEXT_NODE) {
          const textNode = nextSibling as Text;
          const text = textNode.textContent || "";
          let markerLen = 0;
          while (markerLen < text.length && text[markerLen] === cursorMarker)
            markerLen++;
          range.setStart(textNode, markerLen);
        } else {
          range.setStartAfter(tag);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      };

      const insertMention = (
        item: RichMentionItem,
        options?: { replaceExisting?: boolean },
      ) => {
        const editor = editorRef.current;
        if (!editor) return;

        const selection = window.getSelection();
        const activeRange =
          selection && selection.rangeCount > 0
            ? selection.getRangeAt(0)
            : null;
        const activeRangeInEditor = activeRange
          ? editor.contains(activeRange.commonAncestorContainer)
          : false;

        // A caret resting right after a mention means the user wants to replace
        // that mention. Batch insertions leave the caret in exactly that spot,
        // so they must opt out or each file would overwrite the previous one.
        const allowReplaceExisting = options?.replaceExisting !== false;
        const info = activeRangeInEditor ? (getMentionInfo() as any) : null;
        const replacementRange = document.createRange();

        // 1. Handle the re-select case where we have a direct targetTag
        if (allowReplaceExisting && info?.isReSelect && info.targetTag) {
          replacementRange.setStartBefore(info.targetTag);
          const nextSibling = info.targetTag.nextSibling;
          if (nextSibling?.nodeType === Node.TEXT_NODE) {
            const nextText = (nextSibling as Text).textContent || "";
            const markerMatch = nextText.match(/^\uFEFF+/);
            if (markerMatch && markerMatch[0].length > 0) {
              replacementRange.setEnd(nextSibling, markerMatch[0].length);
            } else {
              replacementRange.setEndAfter(info.targetTag);
            }
          } else {
            replacementRange.setEndAfter(info.targetTag);
          }
        } else if (info && !info.isReSelect) {
          // 2. Standard insertion case (triggered by '@')
          if (!activeRange) return;
          const textNode = activeRange.startContainer;
          if (textNode.nodeType !== Node.TEXT_NODE) return;
          replacementRange.setStart(textNode, info.index);
          replacementRange.setEnd(textNode, activeRange.startOffset);
        } else {
          // 3. Fallback for file drops and programmatic insertions (no '@' context)
          const fallbackRange =
            activeRange && activeRangeInEditor
              ? activeRange
              : createEditorEndRange();
          if (!fallbackRange) return;
          replacementRange.setStart(
            fallbackRange.startContainer,
            fallbackRange.startOffset,
          );
          replacementRange.setEnd(
            fallbackRange.startContainer,
            fallbackRange.startOffset,
          );
        }

        editor.focus();
        setSelectionRange(replacementRange);
        const insertId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const html = buildMentionHtml(item, insertId);
        document.execCommand("insertHTML", false, html);
        const insertedTag = editorRef.current?.querySelector(
          `.mention-tag[data-insert-id="${insertId}"]`,
        ) as HTMLElement | null;
        if (insertedTag) {
          insertedTag.removeAttribute("data-insert-id");
          placeCaretAfterInsertedTag(insertedTag);
        }

        editorRef.current?.focus();
        pendingMentionDeleteRef.current = null;
        setSuggestionMode("mention");
        setPassChatLoading(false);
        setPassChatError("");
        setShowSuggestions(false);
        onInput?.(buildDraft());
      };

      const acceptSuggestion = (item: RichMentionItem | undefined) => {
        if (!item) return;
        if (item.type === "pass-chat-spec") {
          void openPassChatPicker();
          return;
        }
        insertMention(item);
      };

      const serialize = (): string => {
        if (!editorRef.current) return "";
        let result = "";
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            result +=
              node.textContent
                ?.replace(/\u00A0/g, " ")
                .replace(/\uFEFF/g, "") || "";
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (el.classList.contains("mention-tag")) {
              const type = el.dataset.type;
              const name = el.dataset.name;
              const id = el.dataset.id;
              if (type === "skill") {
                result += `[MENTION_SKILL:#${name}#]`;
              } else if (type === "terminal") {
                result += `[MENTION_TAB:#${name}##${id}#]`;
              } else if (type === "file") {
                result += `[MENTION_FILE:#${name}#]`;
              } else if (type === "pass-chat" && id) {
                result +=
                  encodePassChatMentionToken(id, name || "Chat") ||
                  `@Pass Chat: ${name || "Chat"}`;
              }
            } else if (el.tagName === "BR") {
              result += "\n";
            } else {
              for (let i = 0; i < el.childNodes.length; i++) {
                walk(el.childNodes[i]);
              }
              if (window.getComputedStyle(el).display === "block") {
                result += "\n";
              }
            }
          }
        };
        for (let i = 0; i < editorRef.current.childNodes.length; i++) {
          walk(editorRef.current.childNodes[i]);
        }
        return result.trim();
      };

      useImperativeHandle(ref, () => ({
        focus: () => editorRef.current?.focus(),
        getValue: () => serialize(),
        setValue: (val: string) => {
          if (editorRef.current) {
            restoreRichInputText(editorRef.current, val);
          }
          updateImageAttachments(() => []);
        },
        getDraft: () => buildDraft(),
        setDraft: (draft: {
          text?: string;
          images?: DraftInputImageAttachment[];
        }) => {
          const nextText = typeof draft?.text === "string" ? draft.text : "";
          const nextImages = Array.isArray(draft?.images) ? draft.images : [];
          if (editorRef.current) {
            restoreRichInputText(editorRef.current, nextText);
          }
          updateImageAttachments(() => {
            const mapped = nextImages
              .map((item, index) =>
                normalizeAttachment(item, `rollback-${Date.now()}-${index}`),
              )
              .filter((item): item is ComposerImageAttachment => item !== null);
            return mapped;
          });
        },
        clear: () => {
          if (editorRef.current) editorRef.current.innerHTML = "";
          updateImageAttachments(() => []);
        },
      }));

      const removeReselectedMentionTag = (targetTag: HTMLElement) => {
        const range = document.createRange();
        range.setStartBefore(targetTag);
        const nextSibling = targetTag.nextSibling;
        if (nextSibling?.nodeType === Node.TEXT_NODE) {
          const nextText = (nextSibling as Text).textContent || "";
          const markerMatch = nextText.match(/^\uFEFF+/);
          if (markerMatch && markerMatch[0].length > 0) {
            range.setEnd(nextSibling, markerMatch[0].length);
          } else {
            range.setEndAfter(targetTag);
          }
        } else {
          range.setEndAfter(targetTag);
        }
        setSelectionRange(range);
        document.execCommand("delete");
      };

      const handleKeyDown = (e: React.KeyboardEvent) => {
        if (shouldLetImeHandleKeyDown(imeCompositionRef.current, e)) {
          return;
        }
        if (shouldSuppressPostCompositionEnter(imeCompositionRef.current, e)) {
          e.preventDefault();
          return;
        }

        if (e.key === "Backspace") {
          const info = getMentionInfo() as any;
          if (info?.isReSelect && info.targetTag instanceof HTMLElement) {
            e.preventDefault();
            if (pendingMentionDeleteRef.current === info.targetTag) {
              removeReselectedMentionTag(info.targetTag);
              pendingMentionDeleteRef.current = null;
              setShowSuggestions(false);
              onInput?.(buildDraft());
            } else {
              pendingMentionDeleteRef.current = info.targetTag;
              updateSuggestions();
            }
            return;
          }
          pendingMentionDeleteRef.current = null;
        }

        if (showSuggestions) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (suggestions.length > 0) {
              setSelectedIndex((i) => (i + 1) % suggestions.length);
            }
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            if (suggestions.length > 0) {
              setSelectedIndex(
                (i) => (i - 1 + suggestions.length) % suggestions.length,
              );
            }
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            acceptSuggestion(suggestions[selectedIndex]);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            pendingMentionDeleteRef.current = null;
            if (suggestionMode === "pass-chat") {
              passChatLoadRequestRef.current += 1;
              setSuggestionMode("mention");
              setPassChatLoading(false);
              setPassChatError("");
              updateSuggestions();
              return;
            }
            setShowSuggestions(false);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const draft = buildDraft();
          if (draft.text.trim() || draft.images.length > 0) {
            onSend(draft);
          }
        }
      };

      const handleInput = () => {
        pendingMentionDeleteRef.current = null;
        updateSuggestions();
        onInput?.(buildDraft());
      };

      const handleCompositionEnd = () => {
        markImeCompositionEnd(imeCompositionRef.current);
        requestAnimationFrame(() => {
          onInput?.(buildDraft());
        });
      };

      // Close suggestions when disabled or when overlay opens
      React.useEffect(() => {
        if (disabled || store.view !== "main") {
          setShowSuggestions(false);
          setSuggestionMode("mention");
          setPassChatLoading(false);
          setPassChatError("");
        }
      }, [disabled, store.view]);

      React.useLayoutEffect(() => {
        if (!showSuggestions) return;
        recomputeSuggestionPlacement();
      }, [
        recomputeSuggestionPlacement,
        showSuggestions,
        suggestionAnchorRect,
        suggestions.length,
      ]);

      React.useLayoutEffect(() => {
        if (!showSuggestions) return;
        const menu = suggestionMenuRef.current;
        const activeItem = suggestionItemRefs.current[selectedIndex] || null;
        if (!menu || !activeItem) return;

        const nextScrollTop = resolveActiveMenuItemScrollTop({
          itemTop: activeItem.offsetTop,
          itemHeight: activeItem.offsetHeight,
          viewportScrollTop: menu.scrollTop,
          viewportHeight: menu.clientHeight,
        });
        if (nextScrollTop !== menu.scrollTop) {
          menu.scrollTop = nextScrollTop;
        }
      }, [selectedIndex, showSuggestions, suggestions.length]);

      React.useEffect(() => {
        if (!showSuggestions) {
          setSuggestionAnchorRect(null);
          setSuggestionStyle(undefined);
          suggestionItemRefs.current = [];
          return;
        }

        const handleReflow = () => {
          const info = getMentionInfo();
          const anchorRect = info ? resolveSuggestionAnchorRect(info) : null;
          if (anchorRect) {
            setSuggestionAnchorRect(anchorRect);
          } else {
            recomputeSuggestionPlacement();
          }
        };

        window.addEventListener("resize", handleReflow);
        window.addEventListener("scroll", handleReflow, true);
        return () => {
          window.removeEventListener("resize", handleReflow);
          window.removeEventListener("scroll", handleReflow, true);
        };
      }, [
        recomputeSuggestionPlacement,
        resolveSuggestionAnchorRect,
        showSuggestions,
      ]);

      React.useEffect(() => {
        imageAttachmentsRef.current = imageAttachments;
        onInput?.(buildDraft());
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [imageAttachments]);

      const attachLocalImages = async (files: File[]): Promise<void> => {
        if (!Array.isArray(files) || files.length === 0) return;
        const created: ComposerImageAttachment[] = [];
        for (const file of files) {
          try {
            const attachment = await buildImageFromLocalFile(file);
            if (attachment) created.push(attachment);
          } catch (err) {
            console.error("[RichInput] Failed to attach image:", err);
          }
        }

        if (created.length === 0) return;
        updateImageAttachments((current) => [...current, ...created]);
      };

      const decodeBase64ToFile = (
        contentBase64: string,
        fileName: string,
        mimeType?: string,
      ): File => {
        const cleaned = String(contentBase64 || "").replace(/^data:[^,]+,/, "");
        const binary = atob(cleaned);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const resolvedType =
          String(mimeType || "").trim() || "application/octet-stream";
        return new File([bytes], fileName || "attachment", {
          type: resolvedType,
          lastModified: Date.now(),
        });
      };

      const handleFileSystemPanelDrop = async (
        payload: FileSystemPanelDragPayload,
      ): Promise<void> => {
        const sourceTerminal =
          store.terminalTabs.find(
            (tab) => tab.id === payload.sourceTerminalId,
          ) || null;
        const isLocalSourceTerminal = sourceTerminal?.config?.type === "local";
        const createdImages: ComposerImageAttachment[] = [];
        for (const entry of payload.entries) {
          if (!entry) continue;
          const isImageEntry =
            !entry.isDirectory &&
            isRecognizedImageFile({ name: entry.name, type: "" } as Pick<
              File,
              "name" | "type"
            >);
          // Remote filesystem drops (e.g., SFTP) should never fetch image bytes here.
          // They are represented as regular file mentions to avoid slow remote download on drop.
          if (isImageEntry && isLocalSourceTerminal) {
            try {
              const read = await window.gyshell.filesystem.readFileBase64(
                payload.sourceTerminalId,
                entry.path,
              );
              const file = decodeBase64ToFile(
                read.contentBase64,
                entry.name || read.path,
                read.mimeType,
              );
              const image = await buildImageFromLocalFile(file);
              if (image) {
                createdImages.push(image);
              }
            } catch (error) {
              console.error(
                "[RichInput] Failed to attach dropped filesystem image:",
                error,
              );
            }
            continue;
          }
          const mentionPath = encodeTerminalScopedFilePath(
            payload.sourceTerminalId,
            entry.path,
          );
          insertMention(
            {
              type: "file",
              name: mentionPath,
              preview: entry.name || getFileMentionDisplayName(entry.path),
            },
            { replaceExisting: false },
          );
        }
        if (createdImages.length > 0) {
          updateImageAttachments((current) => [...current, ...createdImages]);
        }
      };

      const handlePaste = (e: React.ClipboardEvent) => {
        const paste = resolveRichInputClipboardPaste(e.clipboardData);
        if (paste.kind === "imageFiles") {
          e.preventDefault();
          void attachLocalImages(paste.files);
          return;
        }

        e.preventDefault();
        document.execCommand("insertText", false, paste.text);
      };

      const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const filesystemAdmission = admitFileSystemPanelDragPayload(
          e.dataTransfer,
        );
        if (filesystemAdmission.kind !== "absent") {
          if (filesystemAdmission.kind === "rejected") return;
          const sourceTerminal = store.terminalTabs.find(
            (tab) => tab.id === filesystemAdmission.payload.sourceTerminalId,
          );
          if (sourceTerminal?.capabilities?.supportsFilesystem !== true) return;
          void handleFileSystemPanelDrop(filesystemAdmission.payload);
          return;
        }
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          const imageCandidates = files.filter((file) =>
            isRecognizedImageFile(file),
          );
          if (imageCandidates.length > 0) {
            void attachLocalImages(imageCandidates);
          }
          const localTerminalId = store.getPreferredLocalTerminalId();
          const getPathForFile = getNativeFilePathResolver();
          files.forEach((f) => {
            const path = resolveNativeFilePath(f, getPathForFile);
            if (path && !isRecognizedImageFile(f)) {
              const mentionPath = localTerminalId
                ? encodeTerminalScopedFilePath(localTerminalId, path)
                : path;
              insertMention(
                {
                  type: "file",
                  name: mentionPath,
                  preview: getFileMentionDisplayName(path),
                },
                { replaceExisting: false },
              );
            }
          });
        }
      };

      React.useEffect(() => {
        return () => {
          disposeImeCompositionTracker(imeCompositionRef.current);
          imageAttachmentsRef.current.forEach((item) =>
            releasePreviewUrl(item.previewUrl),
          );
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return (
        <div className="rich-input-wrapper">
          {imageAttachments.length > 0 && (
            <div className="rich-input-image-strip">
              <button
                type="button"
                className="rich-input-image-clear-all"
                onClick={() => {
                  updateImageAttachments(() => []);
                }}
                aria-label="Remove all images"
                title="Remove all images"
              >
                <X size={18} strokeWidth={2.5} />
              </button>
              {imageAttachments.map((image) => (
                <div key={image.id} className="rich-input-image-chip">
                  <button
                    type="button"
                    className="rich-input-image-remove"
                    onClick={() => {
                      updateImageAttachments((current) =>
                        current.filter((item) => item.id !== image.id),
                      );
                    }}
                    aria-label="Remove image"
                    title="Remove image"
                  >
                    <X size={13} strokeWidth={2.7} />
                  </button>
                  {image.previewUrl ? (
                    <img src={image.previewUrl} alt="Attached image" />
                  ) : (
                    <div className="rich-input-image-missing">IMG</div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div
            ref={editorRef}
            className={`rich-input-editor ${disabled ? "disabled" : ""}`}
            contentEditable={!disabled}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() =>
              markImeCompositionStart(imeCompositionRef.current)
            }
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            data-placeholder={placeholder}
          />

          {showSuggestions &&
            createPortal(
              <div
                ref={suggestionMenuRef}
                className={`mention-suggestions ${suggestionMode === "pass-chat" ? "pass-chat-mode" : ""}`}
                style={{
                  position: "fixed",
                  top: suggestionStyle?.top ?? 0,
                  left: suggestionStyle?.left ?? 0,
                  width: suggestionStyle?.width,
                  maxHeight: suggestionStyle?.maxHeight,
                  maxWidth: suggestionStyle?.maxWidth,
                  visibility: suggestionStyle ? undefined : "hidden",
                  zIndex: 10000,
                }}
              >
                {passChatLoading ? (
                  <div className="suggestion-status">Loading chats...</div>
                ) : passChatError ? (
                  <div className="suggestion-status warning">
                    {passChatError}
                  </div>
                ) : suggestionMode === "pass-chat" &&
                  suggestions.length === 0 ? (
                  <div className="suggestion-status">No chat history</div>
                ) : (
                  suggestions.map((item, i) => (
                    <div
                      key={`${item.type}-${item.id || item.name}-${i}`}
                      ref={(node) => {
                        suggestionItemRefs.current[i] = node;
                      }}
                      className={`suggestion-item suggestion-${item.type} ${i === selectedIndex ? "active" : ""}`}
                      title={
                        item.preview ? `${item.name}\n${item.preview}` : item.name
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptSuggestion(item);
                      }}
                    >
                      <div className="item-content">
                        <span className={`item-type ${item.type}`}>
                          {item.type === "skill"
                            ? "Skill"
                            : item.type === "terminal"
                              ? "Tab"
                              : item.type === "pass-chat-spec"
                                ? "SPEC"
                                : item.type === "pass-chat"
                                  ? "Chat"
                                  : "File"}
                        </span>
                        <span className="item-name">
                          {item.type === "pass-chat"
                            ? truncatePassChatSuggestionTitle(item.name)
                            : item.name}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>,
              document.body,
            )}
        </div>
      );
    },
  ),
);
