import fs from 'fs/promises';
import { SkillService } from '../SkillService';
import { TerminalService } from '../TerminalService';
import { USEFUL_SKILL_TAG, USER_INPUT_TAGS, FILE_CONTENT_TAG, TERMINAL_CONTENT_TAG } from './prompts';
import { detectFileKind } from './read_tools';

/**
 * Helper to parse user input for special labels like skills, terminal tabs, and pastes.
 * It enriches the message content for the AI by fetching referenced data.
 */
export class InputParseHelper {
  static readonly DEFAULT_USER_INPUT_TAG = USER_INPUT_TAGS[0];
  /**
   * Regex to match skill labels: [MENTION_SKILL:#name#]
   */
  private static SKILL_REGEX = /\[MENTION_SKILL:#(.+?)#\]/g;

  /**
   * Regex to match terminal tab labels: [MENTION_TAB:#name##id#]
   */
  private static TAB_REGEX = /\[MENTION_TAB:#(.+?)##(.+?)#\]/g;

  /**
   * Regex to match user paste labels: [MENTION_USER_PASTE:#path##preview#]
   */
  private static PASTE_REGEX = /\[MENTION_USER_PASTE:#(.+?)##(.+?)#\]/g;

  /**
   * Regex to match mentioned files: [MENTION_FILE:#path#] or [MENTION_FILE:#path##name#]
   */
  private static FILE_REGEX = /\[MENTION_FILE:#(.+?)(?:##.+?)?#\]/g;

  /**
   * Parses the input, fetches skill contents and large pastes, and returns enriched 
   * content for AI and display content for the UI.
   */
  static async parseAndEnrich(
    input: string,
    skillService: SkillService,
    terminalService: TerminalService,
    options?: {
      userInputTag?: string
      includeContextDetails?: boolean
      userInputInstruction?: string
      keepTaggedBodyLiteral?: boolean
    }
  ): Promise<{ enrichedContent: string; displayContent: string }> {
    const userInputTag = options?.userInputTag || USER_INPUT_TAGS[0];
    const includeContextDetails = options?.includeContextDetails !== false;
    // 1. Fetch Skill Details
    let skillDetails = '';
    if (includeContextDetails) {
      const skillMatches = Array.from(input.matchAll(this.SKILL_REGEX));
      const skillNames = Array.from(new Set(skillMatches.map(m => m[1])));
      for (const name of skillNames) {
        try {
          const { content } = await skillService.readSkillContentByName(name);
          skillDetails += `${USEFUL_SKILL_TAG}Skill Name: ${name}\nContent:\n${content}\n\n`;
        } catch (err) {
          console.warn(`[InputParseHelper] Failed to fetch skill: ${name}`, err);
        }
      }
    }
    this.SKILL_REGEX.lastIndex = 0; // Reset regex state

    // 2. Fetch Terminal Tab Details
    let tabDetails = '';
    if (includeContextDetails) {
      const tabMatches = Array.from(input.matchAll(this.TAB_REGEX));
      const tabIds = Array.from(new Set(tabMatches.map(m => m[2])));
      for (const id of tabIds) {
        try {
          const tab = terminalService.getAllTerminals().find(t => t.id === id);
          if (tab) {
            const recentOutput = terminalService.getRecentOutput(id);
            tabDetails += `${TERMINAL_CONTENT_TAG}Terminal Tab: ${tab.title} (ID: ${id})
================================================================================
<terminal_content>
${recentOutput}
</terminal_content>
================================================================================\n\n`;
          }
        } catch (err) {
          console.warn(`[InputParseHelper] Failed to fetch terminal output: ${id}`, err);
        }
      }
    }
    this.TAB_REGEX.lastIndex = 0; // Reset regex state

    // 3. Fetch Large Paste & Mentioned File Details
    let fileDetails = '';
    if (includeContextDetails) {
      const pasteMatches = Array.from(input.matchAll(this.PASTE_REGEX));
      const fileMatches = Array.from(input.matchAll(this.FILE_REGEX));
      const allFileMatches = [
        ...pasteMatches.map(m => ({ filePath: m[1] })),
        ...fileMatches.map(m => ({ filePath: m[1] }))
      ];
      const uniqueFilePaths = Array.from(new Set(allFileMatches.map(m => m.filePath)));
      for (const filePath of uniqueFilePaths) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.size < 4000) {
            const buffer = await fs.readFile(filePath);
            const kind = detectFileKind(filePath, new Uint8Array(buffer));
            if (kind === 'text') {
              const content = buffer.toString('utf-8');
              fileDetails += `${FILE_CONTENT_TAG}<${filePath}>\n${content}\n\n`;
            }
          }
        } catch (err) {
          console.warn(`[InputParseHelper] Failed to read file: ${filePath}`, err);
        }
      }
    }
    this.PASTE_REGEX.lastIndex = 0; // Reset regex state
    this.FILE_REGEX.lastIndex = 0; // Reset regex state

    const normalizedInstruction = String(options?.userInputInstruction || '').trim();
    const keepTaggedBodyLiteral = options?.keepTaggedBodyLiteral === true;
    const taggedInputLiteral = `"${userInputTag}${input}`;
    const userBody = normalizedInstruction
      ? keepTaggedBodyLiteral
        ? `${normalizedInstruction}\n${taggedInputLiteral}`
        : `${normalizedInstruction}\n${input}`
      : input;

    // enrichedContent structure: [Skill Details] + [Tab Details] + [File Details] + [User Body]
    // For inserted mode with keepTaggedBodyLiteral=true, userBody already contains the tagged block.
    let prefix = skillDetails + tabDetails + fileDetails;
    const decoratedBody = keepTaggedBodyLiteral ? userBody : `${userInputTag}${userBody}`;
    const enrichedContent = prefix 
      ? `${prefix}${decoratedBody}` 
      : `${decoratedBody}`;
    
    // displayContent is the original input with labels (used for frontend rendering)
    const displayContent = input;

    return { enrichedContent, displayContent };
  }
}
