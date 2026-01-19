import fs from 'fs';
import path from 'path';

const ANSI = {
  reset: '\x1b[0m',
  white: '\x1b[37m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m'
};

const logDir = path.resolve(process.cwd(), 'logs');
const logFile = path.join(logDir, 'fineauth.log');

function ensureLogDir() {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function serializeDetails(details) {
  if (!details) {
    return '';
  }
  return `\n${JSON.stringify(details, null, 2)}`;
}

function formatLogEntry({ timestamp, category, message, details }) {
  return `[${timestamp}] [${category}] ${message}${serializeDetails(details)}`;
}

function colorizeTag(text, color) {
  return `${color}${text}${ANSI.reset}`;
}

function formatConsoleEntry({ timestamp, category, message, details }) {
  const timeTag = colorizeTag(`[${timestamp}]`, ANSI.cyan);
  const categoryTag = colorizeTag(`[${category}]`, ANSI.magenta);
  const messageText = `${ANSI.white}${message}${ANSI.reset}`;
  const detailText = details ? `${ANSI.white}${serializeDetails(details)}${ANSI.reset}` : '';
  return `${timeTag} ${categoryTag} ${messageText}${detailText}`;
}

export function logEvent(category, message, details = null) {
  const timestamp = new Date().toISOString();
  const entry = formatLogEntry({ timestamp, category, message, details });
  const consoleEntry = formatConsoleEntry({ timestamp, category, message, details });

  console.log(consoleEntry);

  try {
    ensureLogDir();
    fs.appendFileSync(logFile, `${entry}\n`, 'utf-8');
  } catch (error) {
    const warning = colorizeTag('[log]', ANSI.yellow);
    console.warn(`${warning} ${ANSI.white}Failed to write log file: ${error.message}${ANSI.reset}`);
  }
}
