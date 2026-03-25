import { writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomic file write: writes to a temp file in the same directory, then renames.
 * rename() is atomic on POSIX filesystems, so readers never see a partial file.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.${basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmpPath, data, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Rotate backups of a file. Keeps the most recent `keep` copies.
 * Backups are named: <filename>.bak.1, .bak.2, ... .bak.N (1 = most recent).
 */
export function rotateBackups(filePath: string, keep: number = 5): void {
  if (!existsSync(filePath)) return;

  const dir = dirname(filePath);
  const base = basename(filePath);

  // Shift existing backups: .bak.4 → .bak.5, .bak.3 → .bak.4, etc.
  for (let i = keep; i >= 1; i--) {
    const from = join(dir, `${base}.bak.${i}`);
    const to = join(dir, `${base}.bak.${i + 1}`);
    if (existsSync(from)) {
      if (i === keep) {
        // Delete the oldest
        try { unlinkSync(from); } catch {}
      } else {
        try { renameSync(from, to); } catch {}
      }
    }
  }

  // Copy current file to .bak.1
  const newest = join(dir, `${base}.bak.1`);
  try {
    copyFileSync(filePath, newest);
  } catch {}
}
