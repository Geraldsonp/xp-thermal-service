/**
 * Logger Utility
 * Production-grade logging with Pino
 */

import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { LoggingConfig } from '../types';

export type Logger = PinoLogger;

export function createLogger(config: LoggingConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: () => ({})
    }
  };

  // pkg (single-file executable): pino transports (pino-pretty / pino/file)
  // route through thread-stream, which spawns a worker thread that cannot
  // require() modules from the pkg snapshot — the service crashes on its first
  // log line. Fall back to direct streams (JSON to stdout + a file
  // destination); neither uses a worker thread.
  //
  // pino.destination() is SonicBoom, built into pino (no worker thread, plain
  // fs — pkg-safe). Its default sync:false buffers writes through libuv and
  // flushes on the event loop, so a chatty log line never blocks the request
  // path the way sync:true would on a busy till. The trade-off: a hard crash
  // can lose the last buffered lines; winsw's rolled stdout log is the
  // backstop for that window.
  const isPkg = typeof (process as { pkg?: unknown }).pkg !== 'undefined';
  if (isPkg) {
    const streams: Parameters<typeof pino.multistream>[0] = [];
    if (config.console) {
      streams.push({ level: config.level, stream: process.stdout });
    }
    if (config.file) {
      const logDir = path.dirname(config.file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      streams.push({
        level: config.level,
        // sync:false is the SonicBoom default; stated here so the
        // non-blocking property is explicit and grep-able.
        stream: pino.destination({ dest: config.file, sync: false }),
      });
    }
    return streams.length > 0
      ? pino(options, pino.multistream(streams))
      : pino(options);
  }

  // Determine transport targets
  const targets: pino.TransportTargetOptions[] = [];

  // Console transport (pretty print in development)
  if (config.console) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      },
      level: config.level
    });
  }

  // File transport
  if (config.file) {
    // Ensure log directory exists
    const logDir = path.dirname(config.file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    targets.push({
      target: 'pino/file',
      options: {
        destination: config.file,
        mkdir: true
      },
      level: config.level
    });
  }

  // Use transport if we have targets, otherwise plain pino
  if (targets.length > 0) {
    return pino(options, pino.transport({ targets }));
  }

  return pino(options);
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(parent: Logger, context: Record<string, unknown>): Logger {
  return parent.child(context);
}

/**
 * Default logger (for use before configuration is loaded)
 */
export const defaultLogger =
  typeof (process as { pkg?: unknown }).pkg !== 'undefined'
    ? pino({ level: 'info' })
    : pino({
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard'
          }
        }
      });

export default createLogger;
