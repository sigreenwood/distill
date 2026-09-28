import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { logsDir, logFile } from './paths.js';

export interface LoggerConfig {
  level: string;
  pretty: boolean;
}

export function createLogger(cfg: LoggerConfig): pino.Logger {
  mkdirSync(logsDir(), { recursive: true });

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
