import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "../config";
import type { Runtime } from "../runtime";
import type { Context, Json } from "../types";
import { publicFetch, downloadPublic } from "../network";
import { sleep } from "../io";
export class WebTools {
  constructor(
    private config: Config,
    private runtime: Runtime,
  ) {}
  private async mcp<T>(
    url: string,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error("MCP requires public HTTPS");
    const client = new Client({ name: "hibana", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(u, {
      fetch: publicFetch as typeof fetch,
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }
  async remote(name: string, a: Json, ctx: Context) {
    const settings = this.runtime.guild(ctx.guildId);
    if (settings.mcp_enabled === false)
      throw new Error("Remote MCP is disabled");
    return this.mcp(
      settings.mcp_url ?? "https://ww.hsincode.com/api/mcp",
      async (client) => {
        if (name === "mcp_call_tool")
          return client.callTool(
            { name: String(a.name), arguments: (a.arguments as Json) ?? {} },
            undefined,
            { timeout: 60000 },
          );
        const tools: unknown[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
          const page = await client.listTools({ cursor });
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return { tools };
      },
    );
  }
  async search(name: string, a: Json, ctx: Context) {
    ctx.signal?.throwIfAborted();
    if (!this.config.webSearch) throw new Error("Web search disabled");
    if (!this.config.exaKey) {
      const result = await this.mcp("https://mcp.exa.ai/mcp", (c) =>
        c.callTool(
          {
            name: name === "websearch" ? "web_search_exa" : name,
            arguments:
              name === "websearch"
                ? { query: a.query, numResults: a.num_results ?? 8 }
                : name === "web_fetch_exa"
                  ? { urls: a.urls ?? [a.url] }
                  : a,
          },
          undefined,
          { timeout: 60000, signal: ctx.signal },
        ),
      );
      // Exa's public MCP returns this quota notice with isError=false. Treating
      // it as evidence lets Jev advance dependent steps without search results.
      // Match the provider's leading diagnostic, not words inside search hits.
      if (Array.isArray(result.content) && result.content.some(block =>
        block.type === "text" && typeof block.text === "string" &&
        block.text.trimStart().startsWith("You've hit Exa's free MCP rate limit.")))
        throw new Error("Exa public MCP rate limit reached. No search results were returned. Use another available source instead of repeating this request; EXA_API_KEY enables the dedicated Exa API.");
      return result;
    }
    const path = name === "web_fetch_exa" ? "/contents" : "/search";
    const body: Json =
      name === "web_fetch_exa"
        ? {
            ids: a.urls ?? [a.url],
            text: { maxCharacters: a.max_characters ?? 10000 },
          }
        : {
            query: a.query,
            numResults: Math.min(100, Math.max(1, Number(a.num_results ?? 8))),
            type: a.type ?? "auto",
            contents: { text: { maxCharacters: 10000 } },
          };
    for (const [from, to] of Object.entries({
      include_domains: "includeDomains",
      exclude_domains: "excludeDomains",
      start_published_date: "startPublishedDate",
      end_published_date: "endPublishedDate",
      include_text: "includeText",
      exclude_text: "excludeText",
      category: "category",
      user_location: "userLocation",
    }))
      if (a[from] !== undefined) body[to] = a[from];
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await publicFetch(`https://api.exa.ai${path}`, {
        method: "POST",
        headers: {
          "x-api-key": this.config.exaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctx.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
      if (res.status === 429 && attempt < 2) {
        await res.body?.cancel();
        await sleep(
          Math.min(
            10000,
            Math.max(500, Number(res.headers.get("retry-after") ?? 1) * 1000),
          ),
          ctx.signal,
        );
        continue;
      }
      if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
      return res.json();
    }
    throw new Error("Exa retry limit reached");
  }
  async fetch(url: string, ctx: Context) {
    const r = await downloadPublic(url, ctx.signal, 200000);
    return {
      url,
      content: (await r.text())
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .slice(0, 40000),
    };
  }
}
