import { env } from "cloudflare:workers";

export async function genBotPlushkinSecretKey(token: string) {
  const encoder = new TextEncoder();

  return await hmacKey(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(encoder.encode("TestRunner")),
      encoder.encode(token),
    ),
  );
}

export async function hmacKey(arr: Uint8Array | ArrayBuffer) {
  return await crypto.subtle.importKey(
    "raw",
    arr,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function verifyRequest(request: Request) {
  const auth = request.headers.get("Authorization")
    ? /Bearer (?<token>.+)/.exec(request.headers.get("Authorization")!)
    : null;

  if (auth && auth.groups) {
    const token = auth.groups.token;

    return await crypto.subtle.verify(
      "HMAC",
      await genBotPlushkinSecretKey(env.TG_BOT_TOKEN),
      Buffer.from(token, "base64"),
      new TextEncoder().encode(env.PLUSHKIN_TRIGGER),
    );
  } else {
    return false;
  }
}
