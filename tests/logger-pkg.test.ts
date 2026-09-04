/**
 * Tests for the pkg-mode logger.
 *
 * pkg builds cannot use pino transports (thread-stream spawns a worker that
 * cannot require() from the snapshot), so pkg mode falls back to direct
 * streams. The property under test here: the file destination must be
 * ASYNC — a sync file stream would block the request path on every log line
 * on a busy till.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import { createLogger } from '../src/utils/logger';

function pkgFileStreams(logger: pino.Logger): Array<{ sync: boolean; file?: string }> {
  const multistream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] as {
    streams: Array<{ stream: { sync?: boolean; file?: string; path?: string } }>;
  } | undefined;
  if (!multistream) return [];
  return multistream.streams
    .map((s) => s.stream)
    .filter((s) => typeof s.sync === 'boolean')
    .map((s) => ({ sync: s.sync as boolean, file: s.file ?? s.path }));
}

describe('the pkg logger', () => {
  afterEach(() => {
    delete (process as { pkg?: unknown }).pkg;
  });

  it('writes the log file through a NON-sync (non-blocking) destination', () => {
    (process as { pkg?: unknown }).pkg = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xplogger-'));
    const file = path.join(dir, 'service.log');

    const logger = createLogger({ level: 'info', file, console: false });

    const fileStreams = pkgFileStreams(logger);
    expect(fileStreams.length).toBeGreaterThan(0);
    for (const s of fileStreams) {
      expect(s.sync).toBe(false);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still lands log lines in the file', async () => {
    (process as { pkg?: unknown }).pkg = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xplogger-'));
    const file = path.join(dir, 'service.log');

    const logger = createLogger({ level: 'info', file, console: false });
    logger.info('flush-me');

    // sync:false flushes through the event loop, so poll briefly.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let contents = '';
    for (let i = 0; i < 50 && !contents.includes('flush-me'); i++) {
      await sleep(20);
      contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    expect(contents).toContain('flush-me');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
