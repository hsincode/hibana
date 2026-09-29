import { join } from "node:path";
import { createApp } from "./app";
import { Deployer, readLogs, runCommand } from "./deploy";
import { loadEnv } from "./env";
import { KeyStore } from "./keys";

const env = loadEnv();
const deployer = new Deployer(env, {
  // The relay runs from the same checkout it deploys. When a deploy changes
  // its own code, exit after the response has been flushed and let systemd
  // (Restart=always) start the new version. History survives in deployments.json.
  onSelfUpdate: () => {
    console.log(JSON.stringify({ msg: "relay code changed; restarting" }));
    setTimeout(() => process.exit(0), 1000);
  },
});
await deployer.load();

const app = createApp({
  keys: new KeyStore(join(env.stateDir, "keys.json")),
  deployer,
  readLogs: (opts) => readLogs(env, opts),
  currentCommit: async () => {
    const r = await runCommand(["git", "rev-parse", "HEAD"], { cwd: env.appDir });
    return r.code === 0 ? r.stdout.trim() : null;
  },
});

const i = env.bind.lastIndexOf(":");
app.listen({ hostname: env.bind.slice(0, i), port: Number(env.bind.slice(i + 1)) });
console.log(JSON.stringify({ msg: "hibana-relay listening", bind: env.bind, appDir: env.appDir }));
