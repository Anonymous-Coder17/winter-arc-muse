import "server-only";

// lib/google/tokenVault.ts
//
// SERVER ONLY. AES-256-GCM encryption for Google OAuth tokens at rest.
// Tokens are stored in Postgres as "v1:<base64 iv>:<base64 ciphertext>:<base64 tag>".
//
// The 32-byte key comes from GOOGLE_TOKEN_ENCRYPTION_KEY, accepted as either
// a 64-char hex string or a 44-char base64 string. The key is read from the
// environment at use-time; a missing/invalid key throws a clear configuration
// error and the key value is NEVER logged, echoed, or embedded in errors.

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

const KEY_ENV_VAR = "GOOGLE_TOKEN_ENCRYPTION_KEY";
const BLOB_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_BLOB_CHARS = 16_384;

function readEncryptionKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `Google token encryption is not configured (${KEY_ENV_VAR} is missing).`
    );
  }
  const value = raw.trim();

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return Buffer.from(value, "base64");
  }
  throw new Error(
    `Google token encryption key is invalid (expected a 64-char hex string or a 44-char base64 string in ${KEY_ENV_VAR}).`
  );
}

/**
 * Encrypt a plaintext OAuth token. Output format:
 * "v1:" + base64(iv) + ":" + base64(ciphertext) + ":" + base64(auth tag).
 */
export function encryptToken(plain: string): string {
  const key = readEncryptionKey(); // throws a clear config error when misconfigured
  if (!plain) {
    throw new Error("Cannot encrypt an empty token.");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    `${BLOB_VERSION}:` +
    iv.toString("base64") +
    ":" +
    ciphertext.toString("base64") +
    ":" +
    tag.toString("base64")
  );
}

function isBase64Chars(s: string): boolean {
  return s.length > 0 && /^[A-Za-z0-9+/=]+$/.test(s);
}

/**
 * Decrypt a blob produced by encryptToken. On ANY failure — bad format,
 * wrong key, tampered ciphertext — throws a single generic error that never
 * includes token material.
 */
export function decryptToken(blob: string): string {
  const key = readEncryptionKey(); // throws a clear config error when misconfigured
  try {
    if (
      typeof blob !== "string" ||
      blob.length === 0 ||
      blob.length > MAX_BLOB_CHARS
    ) {
      throw new Error("bad blob");
    }
    const parts = blob.split(":");
    if (parts.length !== 4) {
      throw new Error("bad blob");
    }
    const [version, ivB64, ctB64, tagB64] = parts;

    // Constant-time version check.
    const expectedVersion = Buffer.from(BLOB_VERSION, "utf8");
    const actualVersion = Buffer.from(version, "utf8");
    if (
      actualVersion.length !== expectedVersion.length ||
      !timingSafeEqual(actualVersion, expectedVersion)
    ) {
      throw new Error("bad blob");
    }
    if (!isBase64Chars(ivB64) || !isBase64Chars(ctB64) || !isBase64Chars(tagB64)) {
      throw new Error("bad blob");
    }

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");
    if (
      iv.length !== IV_BYTES ||
      tag.length !== TAG_BYTES ||
      ciphertext.length === 0
    ) {
      throw new Error("bad blob");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    if (!plain) {
      throw new Error("bad blob");
    }
    return plain;
  } catch {
    // Generic on purpose: never leak whether the format, key, or tag failed,
    // and never include token material.
    throw new Error("Token decryption failed.");
  }
}
