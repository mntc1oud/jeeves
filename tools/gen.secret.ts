import crypto from "node:crypto";

const { subtle } = crypto.webcrypto;

const key = await subtle.generateKey(
  {
    name: "HMAC",
    hash: "SHA-256",
    length: 256,
  },
  true,
  ["sign", "verify"],
);

const buf = await subtle.exportKey("jwk", key);
