import { lookup } from "node:dns/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable, Transform } from "node:stream";
import ipaddr from "ipaddr.js";

// Surfshark/VPN Gate tinyproxy is process-wide and never taken from model args.
// A per-request proxy is the task-scoped home relay, which authenticates.
let proxyPort: number | undefined;
export function setPublicProxy(port?: number) {
  proxyPort = port;
}
export type EgressProxy = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};
function proxyAgent(
  url: URL,
  address: string,
  proxy: EgressProxy,
  signal?: AbortSignal | null,
) {
  const secure = url.protocol === "https:",
    agent = secure ? new HttpsAgent() : new HttpAgent();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  agent.createConnection = ((
    _options: unknown,
    callback: (error: Error | null, socket?: Socket) => void,
  ) => {
    const target = `${isIP(address) === 6 ? "[" + address + "]" : address}:${url.port || (secure ? "443" : "80")}`;
    const headers: Record<string, string> = { Host: target };
    if (proxy.username)
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64");
    const tunnel = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: target,
      headers,
      signal: signal ?? undefined,
    });
    tunnel.setTimeout(30000, () =>
      tunnel.destroy(new Error("Proxy timeout")),
    );
    tunnel.once("error", (error) => callback(error));
    tunnel.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      if (secure) {
        const tls = tlsConnect({
          socket,
          servername: isIP(host) ? undefined : host,
          host,
          rejectUnauthorized: true,
        });
        callback(null, tls);
      } else callback(null, socket);
    });
    tunnel.end();
    return undefined;
  }) as typeof agent.createConnection;
  return agent;
}

export function isPublicAddress(address: string): boolean {
  try {
    let addr = ipaddr.parse(address);
    if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress())
      addr = (addr as ipaddr.IPv6).toIPv4Address();
    return addr.range() === "unicast";
  } catch {
    return false;
  }
}
/** Pin the checked DNS result into the connection; validating a hostname before fetch alone permits DNS rebinding. */
export async function publicFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  limit = 32 * 1024 * 1024,
  proxy?: EgressProxy,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only public HTTP(S) URLs without credentials are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    /\.(localhost|local|internal)$/.test(hostname)
  )
    throw new Error("Private hostname blocked");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("Private or reserved network address blocked");
  const req = input instanceof Request ? input : undefined;
  const headers = Object.fromEntries(
    new Headers(init.headers ?? req?.headers).entries(),
  );
  const body =
    init.body ??
    (req && req.method !== "GET" && req.method !== "HEAD"
      ? await req.text()
      : undefined);
  if (body && typeof body !== "string" && !(body instanceof Uint8Array))
    throw new Error("Unsupported request body");
  const signal = init.signal ?? req?.signal;
  const egress = proxy ?? (proxyPort ? { host: "127.0.0.1", port: proxyPort } : undefined);
  const agent = egress
    ? proxyAgent(url, addresses[0]!.address, egress, signal)
    : undefined;
  const response = await new Promise<Response>((resolve, reject) => {
    const make = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = make(
      url,
      {
        method: init.method ?? req?.method ?? "GET",
        headers,
        agent,
        signal: signal ?? undefined,
        lookup: ((_host: string, options: unknown, callback: Function) => {
          const a = addresses[0]!;
          if ((options as { all?: boolean })?.all) callback(null, [a]);
          else callback(null, a.address, a.family);
        }) as never,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined)
            responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        res.once("close", () => agent?.destroy());
        let size = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > limit)
              callback(new Error("Response exceeds size limit"));
            else callback(null, chunk);
          },
        });
        res.on("error", (error) => bounded.destroy(error));
        res.pipe(bounded);
        const stream = Readable.toWeb(
          bounded,
        ) as unknown as ReadableStream<Uint8Array>;
        resolve(
          new Response(
            [204, 205, 304].includes(res.statusCode ?? 200) ? null : stream,
            { status: res.statusCode ?? 502, headers: responseHeaders },
          ),
        );
      },
    );
    request.setTimeout(30000, () =>
      request.destroy(new Error("Network timeout")),
    );
    request.on("error", (error) => {
      agent?.destroy();
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
  // The caller decides whether to follow; credentials must never cross hosts.
  return response;
}
export async function downloadPublic(
  url: string,
  signal?: AbortSignal,
  limit = 32 * 1024 * 1024,
  proxy?: EgressProxy,
) {
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await publicFetch(url, { signal }, limit, proxy);
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      url = new URL(response.headers.get("location")!, url).href;
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    return response;
  }
  throw new Error("Too many redirects");
}
