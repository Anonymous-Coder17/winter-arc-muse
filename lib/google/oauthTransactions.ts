import "server-only";

// lib/google/oauthTransactions.ts
//
// SERVER ONLY. Single-use OAuth transaction ledger for the Google consent
// flow. The browser holds only a random transaction id (in a narrow-scoped
// httpOnly cookie); the OAuth state, the PKCE verifier, and the owner
// binding live here, server-side. Nothing sensitive and no user binding
// ever sits in a client cookie.
//
// Lifecycle: start route inserts a row (encrypted verifier, TTL) -> Google
// redirects the user back -> callback atomically consumes the row. The
// consume is single-use: the row is deleted inside the same call, so a
// transaction id can never be replayed, and the owner is compared against
// the session user inside the consume itself.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { decryptToken, encryptToken } from "./tokenVault";

export interface CreateOAuthTransactionParams {
  /** CSRF state parameter sent to Google. */
  state: string;
  /** PKCE code verifier (stored as AES-256-GCM ciphertext, never plaintext). */
  verifier: string;
  /** Transaction lifetime in seconds. Defaults to 600 (10 minutes). */
  ttlSeconds?: number;
}

export interface ConsumedOAuthTransaction {
  state: string;
  verifier: string;
}

/**
 * Create an OAuth transaction row and return its id. Opportunistically
 * deletes the user's own expired rows first so stale transactions cannot
 * accumulate.
 */
export async function createOAuthTransaction(
  supabase: SupabaseClient,
  userId: string,
  { state, verifier, ttlSeconds = 600 }: CreateOAuthTransactionParams
): Promise<string> {
  await supabase
    .from("google_oauth_transactions")
    .delete()
    .eq("owner", userId)
    .lt("expires_at", new Date().toISOString());

  const id = randomUUID();
  const { error } = await supabase.from("google_oauth_transactions").insert({
    id,
    owner: userId,
    state,
    verifier_enc: encryptToken(verifier),
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
  if (error) {
    throw new Error("Could not start the OAuth transaction.");
  }
  return id;
}

/**
 * Atomically consume a transaction. Only an unconsumed, unexpired row owned
 * by the caller can match: it is marked consumed and returned in one
 * conditional update, then deleted, so the transaction id is unusable after
 * this call — never replayable, and never usable by a different user.
 * Returns null when the transaction is missing, expired, already consumed,
 * or owned by someone else.
 */
export async function consumeOAuthTransaction(
  supabase: SupabaseClient,
  userId: string,
  txnId: string
): Promise<ConsumedOAuthTransaction | null> {
  const { data, error } = await supabase
    .from("google_oauth_transactions")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", txnId)
    .eq("owner", userId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("state, verifier_enc")
    .maybeSingle();

  if (error || !data) return null;

  const verifier = decryptToken(data.verifier_enc as string);

  // The row is deleted the moment it is consumed; a transaction id is
  // strictly single-use.
  await supabase
    .from("google_oauth_transactions")
    .delete()
    .eq("id", txnId)
    .eq("owner", userId);

  return { state: data.state as string, verifier };
}

/**
 * Best-effort delete of a transaction, used on failure/cancel paths so no
 * stale transaction can survive an aborted flow. Never throws.
 */
export async function deleteOAuthTransaction(
  supabase: SupabaseClient,
  userId: string,
  txnId: string
): Promise<void> {
  try {
    await supabase
      .from("google_oauth_transactions")
      .delete()
      .eq("id", txnId)
      .eq("owner", userId);
  } catch {
    // Best-effort by design: the row expires on its own if this fails.
  }
}
