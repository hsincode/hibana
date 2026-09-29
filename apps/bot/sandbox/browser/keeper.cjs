// Container PID 1's child. Reclaims Chromium even if the bot crashes/restarts.
const fs = require('node:fs');
const started = Date.now();
const activity = '/tmp/browser-activity';
fs.writeFileSync(activity, '');
setInterval(() => {
  const idle = Date.now() - fs.statSync(activity).mtimeMs;
  if (idle > 10 * 60_000 || Date.now() - started > 60 * 60_000)
    process.exit(0);
}, 5_000);
