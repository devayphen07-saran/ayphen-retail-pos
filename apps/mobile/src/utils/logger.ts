type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveLevel(): number {
  const raw = process.env['EXPO_PUBLIC_LOG_LEVEL'] as LogLevel | undefined;
  return LEVELS[raw ?? 'info'] ?? LEVELS.info;
}

class Logger {
  private readonly level = resolveLevel();

  debug(msg: string, data?: unknown): void {
    if (this.level <= LEVELS.debug) console.log(`[DEBUG] ${msg}`, ...(data !== undefined ? [data] : []));
  }

  info(msg: string, data?: unknown): void {
    if (this.level <= LEVELS.info) console.info(`[INFO] ${msg}`, ...(data !== undefined ? [data] : []));
  }

  warn(msg: string, data?: unknown): void {
    if (this.level <= LEVELS.warn) console.warn(`[WARN] ${msg}`, ...(data !== undefined ? [data] : []));
  }

  error(msg: string, error?: unknown): void {
    if (this.level <= LEVELS.error) console.error(`[ERROR] ${msg}`, ...(error !== undefined ? [error] : []));
  }
}

export const logger = new Logger();
export default logger;
