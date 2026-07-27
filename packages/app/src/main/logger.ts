import fs from 'node:fs';
import pino from 'pino';
import { logsDir, logFile } from './paths.js';

export type Logger = pino.Logger;

export interface LoggerConfig {
  level: string;
  /** In dev we also pretty-print to stdout; packaged builds log to file only. */
  pretty: boolean;
}

export function createLogger(cfg: LoggerConfig): Logger {
  fs.mkdirSync(logsDir(), { recursive: true });
  const transport = cfg.pretty
    ? {
        targets: [
          {
            target: 'pino-pretty',
            level: cfg.level,
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
          {
            target: 'pino/file',
            level: cfg.level,
            options: { destination: logFile(), mkdir: true },
          },
        ],
      }
    : {
        target: 'pino/file',
        options: { destination: logFile(), mkdir: true },
      };
  return pino({
    level: cfg.level,
    transport,
    base: { app: 'distill' },
  });
}
