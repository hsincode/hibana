import { expect, test } from "bun:test";
import { join } from "node:path";

interface Redirect {
  has?: { type: string; value?: string }[];
  missing?: { type: string; key?: string }[];
}

// Both apps send *.vercel.app requests on to their production domain. A staged
// deployment is only reachable at such a host, so the deploy job could never
// check it before promoting (docs/adr/0005). Requests that carry the protection
// bypass header are the deploy job's own and must reach the deployment.
for (const app of ["api", "web"]) {
  test(`${app}: the *.vercel.app redirect lets the deploy job's check through`, async () => {
    const config = (await Bun.file(join(import.meta.dir, `../apps/${app}/vercel.json`)).json()) as { redirects: Redirect[] };
    const rule = config.redirects.find((r) => r.has?.some((h) => h.type === "host" && h.value === ".*\\.vercel\\.app"));
    expect(rule).toBeDefined();
    expect(rule!.missing).toEqual([{ type: "header", key: "x-vercel-protection-bypass" }]);
  });
}
