/**
 * Retryability classification for the barcode width fix.
 *
 * A too-wide barcode is a permanent failure: retrying the same bytes can only
 * fail again (the printer has the same physical width). These tests pin the
 * JobProcessor's private isRetryableError table so the width error, its
 * siblings (invalid payload) and a genuinely transient error stay classified
 * correctly — a regression here would send unprintable jobs into an infinite
 * retry loop instead of dead-lettering them.
 */

import { EventEmitter } from 'events';
import { JobProcessor } from '../src/queue/processor';
import { Logger } from '../src/utils/logger';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

// Constructor only needs queue.on(); the rest is untouched by isRetryableError.
const processor = new JobProcessor(
  new EventEmitter() as never,
  {} as never,
  {} as never,
  { maxConcurrentJobs: 1, jobTimeoutMs: 1000, pollIntervalMs: 100 },
  logger
);

const isRetryable = (message: string): boolean =>
  (processor as unknown as { isRetryableError(error: Error): boolean })
    .isRetryableError(new Error(message));

describe('JobProcessor.isRetryableError (barcode width fix)', () => {
  it('marks the too-wide barcode render error non-retryable', () => {
    // Exact message emitted by LabelTemplate.render for a 32-char value on a
    // 48-char printer.
    const message =
      'Barcode too wide for 48-char printer at width 2: 32 characters needs ' +
      '~790 dots but printer has ~576 printable dots. Use a shorter value or ' +
      'a wider printer/2D barcode.';

    expect(isRetryable(message)).toBe(false);
  });

  it('marks invalid-payload errors non-retryable', () => {
    expect(isRetryable('Invalid payload for template: label')).toBe(false);
  });

  it('marks the no-barcode-support render error non-retryable', () => {
    // Exact message emitted by LabelTemplate.render when
    // capabilities.supportsBarcode is false: the printer can never print the
    // job, so retrying only loops until maxRetries instead of dead-lettering.
    expect(
      isRetryable(
        'Label template requires a printer with barcode support (supportsBarcode: false)'
      )
    ).toBe(false);
  });

  it('marks printer-offline errors retryable (transient)', () => {
    expect(isRetryable('Printer offline: label')).toBe(true);
  });

  it('never marks an unprintable job for retry, even after retries re-raise it', () => {
    // The failure path re-checks retryability on each attempt; the width
    // keyword must keep matching so the job dead-letters, not loops.
    const message =
      'Barcode too wide for 32-char printer at width 2: 22 characters needs ' +
      '~570 dots but printer has ~384 printable dots.';
    expect(isRetryable(message)).toBe(false);
  });
});
