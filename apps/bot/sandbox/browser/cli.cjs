// Fixed configuration and a single session; argv never passes through a shell.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const browsers = '/ms-playwright';
const shellDir = fs.readdirSync(browsers).find(name => name.startsWith('chromium_headless_shell-'));
const executablePath = `${browsers}/${shellDir}/chrome-headless-shell-linux64/chrome-headless-shell`;
const config = '/tmp/hibana-browser.json';
const proxyServer = process.env.HIBANA_BROWSER_PROXY_URL;
const proxy = proxyServer ? {
  server: proxyServer,
  username: process.env.HIBANA_BROWSER_PROXY_USERNAME,
  password: process.env.HIBANA_BROWSER_PROXY_PASSWORD,
} : undefined;
fs.writeFileSync(config, JSON.stringify({
  browser: {
    browserName: 'chromium', isolated: true,
    launchOptions: {
      executablePath, headless: true, chromiumSandbox: false,
      ...(proxy ? { proxy, args: [
        // Do not let QUIC, WebRTC or Chromium's implicit localhost bypass
        // silently escape the operator-selected home connection.
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-bypass-list=<-loopback>',
      ] } : {}),
    },
    contextOptions: { viewport: { width: 1280, height: 720 } },
  },
  outputDir: '/workspace/browser-output', outputMode: 'stdout',
}), { mode: 0o600 });
const touch = () => fs.writeFileSync('/tmp/browser-activity', '');
touch();
const args = process.argv.slice(2);
if (args[0] === 'open') args.push(`--config=${config}`);
const child = spawn('playwright-cli', ['-s=hibana', ...args], {
  stdio: 'inherit', env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
});
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => { touch(); process.exit(code ?? 1); });
