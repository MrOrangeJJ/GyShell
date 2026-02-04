import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';

/**
 * Service to manage temporary files created from large user pastes.
 * Ensures the tmp directory exists and implements a cleanup policy.
 */
export class TempFileService {
  private tmpDir: string;
  private readonly MAX_FILES = 20;

  constructor() {
    this.tmpDir = path.join(app.getPath('userData'), 'tmp_pastes');
    this.ensureDir();
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.tmpDir, { recursive: true });
    } catch (err) {
      console.error('[TempFileService] Failed to create tmp directory:', err);
    }
  }

  /**
   * Saves content to a temporary txt file and returns the absolute path.
   */
  async saveTempPaste(content: string): Promise<string> {
    await this.ensureDir();
    const fileName = `paste_${Date.now()}_${uuidv4().slice(0, 8)}.txt`;
    const filePath = path.join(this.tmpDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Cleanup policy: Keep only the 20 most recent files.
   */
  async cleanup() {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.tmpDir);
      if (files.length <= this.MAX_FILES) return;

      // Get stats for all files to sort by mtime
      const fileStats = await Promise.all(
        files.map(async (name) => {
          const filePath = path.join(this.tmpDir, name);
          const stat = await fs.stat(filePath);
          return { name, filePath, mtime: stat.mtimeMs };
        })
      );

      // Sort descending (newest first)
      fileStats.sort((a, b) => b.mtime - a.mtime);

      // Delete files beyond the limit
      const toDelete = fileStats.slice(this.MAX_FILES);
      for (const file of toDelete) {
        await fs.unlink(file.filePath);
      }
      console.log(`[TempFileService] Cleaned up ${toDelete.length} old paste files.`);
    } catch (err) {
      console.error('[TempFileService] Cleanup failed:', err);
    }
  }
}
