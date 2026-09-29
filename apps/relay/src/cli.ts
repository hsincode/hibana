// Key management. Run on the VPS as the relay user so keys.json keeps its owner:
//   sudo -u hibana-deploy /usr/local/bin/bun /opt/hibana/apps/relay/src/cli.ts key create --name github-ci --scope deploy
import { join } from "node:path";
import { loadEnv } from "./env";
import { isScope, KeyStore, SCOPES, type Scope } from "./keys";

const usage = `usage:
  key create --name <name> --scope <${SCOPES.join("|")}> [--scope ...]
  key list
  key revoke <id>`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [group, command, ...rest] = process.argv.slice(2);
if (group !== "key") fail(usage);
const store = new KeyStore(join(loadEnv().stateDir, "keys.json"));

switch (command) {
  case "create": {
    let name = "";
    const scopes: Scope[] = [];
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      const value = rest[++i] ?? fail(`${flag} needs a value`);
      if (flag === "--name") name = value;
      else if (flag === "--scope") scopes.push(isScope(value) ? value : fail(`unknown scope: ${value}`));
      else fail(usage);
    }
    const { key, token } = await store.create(name, scopes);
    console.error(`created ${key.id} (${key.name}) scopes=${key.scopes.join(",")}; the token is shown only once:`);
    console.log(token);
    break;
  }
  case "list":
    for (const k of await store.list()) console.log(`${k.id}\t${k.name}\t${k.scopes.join(",")}\t${k.createdAt}`);
    break;
  case "revoke": {
    const id = rest[0] ?? fail(usage);
    if (!(await store.revoke(id))) fail(`no key ${id}`);
    console.log(`revoked ${id}`);
    break;
  }
  default:
    fail(usage);
}
