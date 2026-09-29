import { bootApp } from "./index";
import { loadEnv } from "./env";

const env = loadEnv();
const app = await bootApp();
const [host, portStr] = env.bind.includes(":")
  ? (() => {
      const i = env.bind.lastIndexOf(":");
      return [env.bind.slice(0, i), env.bind.slice(i + 1)] as const;
    })()
  : ["127.0.0.1", env.bind];
app.listen({
  hostname: host.replace(/^\[/, "").replace(/]$/, ""),
  port: Number(portStr),
});
console.log(`hibana-api listening on ${env.bind}`);
