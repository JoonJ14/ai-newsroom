/**
 * Simple logging utility for AI Newsroom collectors.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  debug: '\x1b[90m',  // gray
};
const RESET = '\x1b[0m';

function log(level: LogLevel, prefix: string, message: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const color = COLORS[level];
  const line = `${color}[${ts}] [${level.toUpperCase()}] [${prefix}]${RESET} ${message}`;

  if (level === 'error') {
    console.error(line, meta !== undefined ? meta : '');
  } else {
    console.log(line, meta !== undefined ? meta : '');
  }
}

export function createLogger(prefix: string) {
  return {
    info: (msg: string, meta?: unknown) => log('info', prefix, msg, meta),
    warn: (msg: string, meta?: unknown) => log('warn', prefix, msg, meta),
    error: (msg: string, meta?: unknown) => log('error', prefix, msg, meta),
    debug: (msg: string, meta?: unknown) => log('debug', prefix, msg, meta),
  };
}
