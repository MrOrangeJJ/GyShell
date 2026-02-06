import React, { useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { AppStore } from '../../stores/AppStore';
import './richInput.scss';

export interface RichInputHandle {
  focus: () => void;
  getValue: () => string;
  setValue: (val: string) => void;
  clear: () => void;
}

interface RichInputProps {
  store: AppStore;
  placeholder?: string;
  onSend: (value: string) => void;
  disabled?: boolean;
}

export const RichInput = observer(forwardRef<RichInputHandle, RichInputProps>(({ 
  store, 
  placeholder, 
  onSend, 
  disabled 
}, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<{ type: 'skill' | 'terminal' | 'file' | 'paste'; name: string; id?: string; preview?: string }[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionPos, setSuggestionPos] = useState({ top: 0, left: 0 });

  const getMentionInfo = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    
    if (!range.collapsed) return null;

    const textNode = range.startContainer;
    
    // Case 1: Cursor is in an element node (like the editor div)
    if (textNode.nodeType !== Node.TEXT_NODE) {
      const siblingBefore = textNode.childNodes[range.startOffset - 1];
      if (siblingBefore instanceof HTMLElement && siblingBefore.classList.contains('mention-tag')) {
        return { query: siblingBefore.dataset.name || '', index: 0, isReSelect: true, targetTag: siblingBefore };
      }
      return null;
    }

    // Case 2: Cursor is in a text node
    const textBefore = textNode.textContent?.slice(0, range.startOffset) || '';
    
    // Check if we are at the beginning of a text node that follows a tag
    const siblingBefore = textNode.previousSibling;
    if (range.startOffset === 0 && siblingBefore instanceof HTMLElement && siblingBefore.classList.contains('mention-tag')) {
      return { query: siblingBefore.dataset.name || '', index: 0, isReSelect: true, targetTag: siblingBefore };
    }

    const lastAtIdx = textBefore.lastIndexOf('@');
    if (lastAtIdx === -1) return null;
    
    if (lastAtIdx > 0 && textBefore[lastAtIdx - 1] !== ' ' && textBefore[lastAtIdx - 1] !== '\u00A0') return null;
    
    return { query: textBefore.slice(lastAtIdx + 1), index: lastAtIdx };
  };

  const updateSuggestions = useCallback(() => {
    const info = getMentionInfo();
    if (!info) {
      setShowSuggestions(false);
      return;
    }

    const query = info.query.toLowerCase();
    
    // Only show enabled skills
    const enabledSkills = store.skills.filter(s => store.settings?.tools?.skills?.[s.name] !== false);
    const skills = enabledSkills.map(s => ({ type: 'skill' as const, name: s.name }));
    const tabs = store.terminalTabs.map(t => ({ type: 'terminal' as const, name: t.title, id: t.id }));
    
    const filtered = [...skills, ...tabs]
      .filter(item => item.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        if (aLower === query && bLower !== query) return -1;
        if (bLower === query && aLower !== query) return 1;
        const aStarts = aLower.startsWith(query);
        const bStarts = bLower.startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (bStarts && !aStarts) return 1;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 10);

    if (filtered.length > 0) {
      setSuggestions(filtered);
      setSelectedIndex(0);
      setShowSuggestions(true);
      
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        const rects = range.getClientRects();
        if (rects.length > 0) {
          const rect = rects[0];
          setSuggestionPos({ top: rect.top - 8, left: rect.left });
        }
      }
    } else {
      setShowSuggestions(false);
    }
  }, [store.skills, store.terminalTabs]);

  const insertMention = (item: { type: 'skill' | 'terminal' | 'file' | 'paste'; name: string; id?: string; preview?: string }) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    
    const info = getMentionInfo() as any;

    // 1. Handle the re-select case where we have a direct targetTag
    if (info?.isReSelect && info.targetTag) {
      // Create mention HTML
      const fileName = item.name.split(/[/\\]/).pop() || item.name;
      const displayText = item.type === 'file' ? fileName : (item.type === 'paste' ? (item.preview || '') : `@${item.name}`);
      
      const html = `<span class="mention-tag" contenteditable="false" 
                    data-type="${item.type}" data-name="${item.name}" 
                    ${item.id ? `data-id="${item.id}"` : ''}
                    ${item.preview ? `data-preview="${item.preview}"` : ''}>${displayText}</span>\uFEFF`;

      // Select the target tag to replace it
      const newRange = document.createRange();
      newRange.selectNode(info.targetTag);
      selection.removeAllRanges();
      selection.addRange(newRange);
      
      // Use insertHTML to replace selection and keep undo stack
      document.execCommand('insertHTML', false, html);
      
      // Force cursor to move after the zero-width non-break space
      selection.modify('move', 'forward', 'character');
      
      setShowSuggestions(false);
      editorRef.current?.focus();
      return;
    }

    // 2. Standard insertion case (triggered by '@')
    if (info && !info.isReSelect) {
      const textNode = range.startContainer;
      if (textNode.nodeType === Node.TEXT_NODE) {
        // Select the "@query" part to replace it
        const newRange = document.createRange();
        newRange.setStart(textNode, info.index);
        newRange.setEnd(textNode, range.startOffset);
        selection.removeAllRanges();
        selection.addRange(newRange);

        const fileName = item.name.split(/[/\\]/).pop() || item.name;
        const displayText = item.type === 'file' ? fileName : (item.type === 'paste' ? (item.preview || '') : `@${item.name}`);
        
        const html = `<span class="mention-tag" contenteditable="false" 
                      data-type="${item.type}" data-name="${item.name}" 
                      ${item.id ? `data-id="${item.id}"` : ''}
                      ${item.preview ? `data-preview="${item.preview}"` : ''}>${displayText}</span>\uFEFF`;

        document.execCommand('insertHTML', false, html);

        // Force cursor to move after the zero-width non-break space
        selection.modify('move', 'forward', 'character');
        
        setShowSuggestions(false);
        editorRef.current?.focus();
        return;
      }
    }

    // 3. Fallback for file drops or pastes (no '@' context)
    const fileName = item.name.split(/[/\\]/).pop() || item.name;
    const displayText = item.type === 'file' ? fileName : (item.preview || '');
    
    const html = `<span class="mention-tag" contenteditable="false" 
                  data-type="${item.type}" data-name="${item.name}" 
                  ${item.preview ? `data-preview="${item.preview}"` : ''}>${displayText}</span>\uFEFF`;

    // Ensure range is inside editor
    if (editorRef.current && !editorRef.current.contains(range.commonAncestorContainer)) {
      const newRange = document.createRange();
      newRange.selectNodeContents(editorRef.current);
      newRange.collapse(false);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    document.execCommand('insertHTML', false, html);
    
    // Force cursor to move after the zero-width non-break space
    selection.modify('move', 'forward', 'character');

    editorRef.current?.focus();
  };

  const serialize = (): string => {
    if (!editorRef.current) return '';
    let result = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent?.replace(/\u00A0/g, ' ') || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.classList.contains('mention-tag')) {
          const type = el.dataset.type;
          const name = el.dataset.name;
          const id = el.dataset.id;
          if (type === 'skill') {
            result += `[MENTION_SKILL:#${name}#]`;
          } else if (type === 'terminal') {
            result += `[MENTION_TAB:#${name}##${id}#]`;
          } else if (type === 'file') {
            result += `[MENTION_FILE:#${name}#]`;
          } else if (type === 'paste') {
            const preview = el.dataset.preview || '';
            result += `[MENTION_USER_PASTE:#${name}##${preview}#]`;
          }
        } else if (el.tagName === 'BR') {
          result += '\n';
        } else {
          for (let i = 0; i < el.childNodes.length; i++) {
            walk(el.childNodes[i]);
          }
          if (window.getComputedStyle(el).display === 'block') {
            result += '\n';
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
        // Parser for [MENTION_XXX:#...#] labels to restore them as rich DOM nodes
        const parts = val.split(/(\[MENTION_(?:SKILL|TAB|FILE|USER_PASTE):#.+?#(?:#.+?#)?\])/g);
        editorRef.current.innerHTML = '';
        
        parts.forEach(part => {
          const skillMatch = part.match(/\[MENTION_SKILL:#(.+?)#\]/);
          const terminalMatch = part.match(/\[MENTION_TAB:#(.+?)##(.+?)#\]/);
          
          if (skillMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'skill';
            span.dataset.name = skillMatch[1];
            span.textContent = `@${skillMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (terminalMatch) {
            const span = document.createElement('span');
            span.className = 'mention-tag';
            span.contentEditable = 'false';
            span.dataset.type = 'terminal';
            span.dataset.name = terminalMatch[1];
            span.dataset.id = terminalMatch[2];
            span.textContent = `@${terminalMatch[1]}`;
            editorRef.current?.appendChild(span);
          } else if (part.match(/\[MENTION_FILE:#(.+?)#\]/)) {
            const fileMatch = part.match(/\[MENTION_FILE:#(.+?)#\]/);
            if (fileMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'file';
              span.dataset.name = fileMatch[1];
              // Extract only the file/folder name for display
              const fileName = fileMatch[1].split(/[/\\]/).pop() || fileMatch[1];
              span.textContent = fileName;
              editorRef.current?.appendChild(span);
            }
          } else if (part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/)) {
            const pasteMatch = part.match(/\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/);
            if (pasteMatch) {
              const span = document.createElement('span');
              span.className = 'mention-tag';
              span.contentEditable = 'false';
              span.dataset.type = 'paste';
              span.dataset.name = pasteMatch[1];
              span.dataset.preview = pasteMatch[2];
              span.textContent = pasteMatch[2];
              editorRef.current?.appendChild(span);
            }
          } else if (part) {
            editorRef.current?.appendChild(document.createTextNode(part.replace(/\u00A0/g, ' ')));
          }
        });
      }
    },
    clear: () => {
      if (editorRef.current) editorRef.current.innerHTML = '';
    }
  }));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = serialize();
      if (val) onSend(val);
    }
  };

  const handleInput = () => {
    updateSuggestions();
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    
    if (text.length > 500) {
      try {
        console.log('[RichInput] Large paste detected, saving to temp file...');
        const tempPath = await (window as any).gyshell.system.saveTempPaste(text);
        console.log('[RichInput] Temp file saved at:', tempPath);
        const preview = text.slice(0, 10).replace(/\n/g, ' ') + '...';
        
        // Use a small timeout to ensure the paste event finishes and editor is ready for DOM manipulation
        setTimeout(() => {
          insertMention({ type: 'paste', name: tempPath, preview });
        }, 0);
      } catch (err) {
        console.error('[RichInput] Failed to save large paste:', err);
        document.execCommand('insertText', false, text);
      }
    } else {
      document.execCommand('insertText', false, text);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    console.log('[RichInput] Files dropped:', files.length);
    if (files.length > 0) {
      files.forEach(f => {
        const path = (f as any).path;
        console.log('[RichInput] Dropped file path:', path);
        if (path) {
          insertMention({ type: 'file', name: path });
        }
      });
    }
  };

  return (
    <div className="rich-input-wrapper">
      <div
        ref={editorRef}
        className={`rich-input-editor ${disabled ? 'disabled' : ''}`}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        data-placeholder={placeholder}
      />
      
      {showSuggestions && createPortal(
        <div 
          className="mention-suggestions"
          style={{ 
            position: 'fixed',
            top: suggestionPos.top,
            left: suggestionPos.left,
            transform: 'translateY(-100%)',
            zIndex: 10000
          }}
        >
          {suggestions.map((item, i) => (
            <div
              key={`${item.type}-${item.name}-${i}`}
              className={`suggestion-item ${i === selectedIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(item);
              }}
            >
              <div className="item-content">
                <span className={`item-type ${item.type}`}>{item.type === 'skill' ? 'Skill' : 'Tab'}</span>
                <span className="item-name">{item.name}</span>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}));
