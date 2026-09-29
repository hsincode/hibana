/** PKCE S256 helpers for Discord OAuth. */

export function randomUrlSafe(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(buf).toString("base64url");
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}
