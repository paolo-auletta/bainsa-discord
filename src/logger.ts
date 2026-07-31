const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function write(level, message, context = {}) {
  const selectedLevel = process.env.LOG_LEVEL || 'info';
  if (LEVELS[level] < (LEVELS[selectedLevel] ?? LEVELS.info)) return;
  const record = { timestamp: new Date().toISOString(), level, message, ...context };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else console.log(output);
}

export const logger = Object.freeze({
  debug: (message, context = {}) => write('debug', message, context),
  info: (message, context = {}) => write('info', message, context),
  warn: (message, context = {}) => write('warn', message, context),
  error: (message, context = {}) => write('error', message, context),
});
