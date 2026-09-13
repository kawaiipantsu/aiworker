import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
const aad = Buffer.from("aiworker-openai-v1");
export function seal(value, key) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}
export function unseal(value, key) {
  const data = Buffer.from(value, "base64");
  if (data.length < 29)
    throw new Error(
      "Stored OpenAI credentials are invalid. Reset the connection in Administration.",
    );
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
