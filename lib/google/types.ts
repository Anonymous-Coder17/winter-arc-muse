// lib/google/types.ts
//
// TypeScript shapes for the Google Calendar integration tables written by
// migration 0008 (public.google_calendar_connections and
// public.google_calendar_selections). Pure module: no Next.js imports, safe
// to use from route handlers and from plain-node unit tests.

export type GoogleCalendarConnectionStatus = "connected" | "revoked" | "error";

export interface GoogleCalendarConnection {
  id: string;
  owner: string;
  google_account_id: string;
  email: string | null;
  status: GoogleCalendarConnectionStatus;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  token_expires_at: string | null;
  scopes: string[];
  created_at: string;
  updated_at: string;
}

export interface GoogleCalendarSelection {
  id: string;
  owner: string;
  connection_id: string;
  google_calendar_id: string;
  calendar_name: string | null;
  time_zone: string | null;
  is_primary: boolean;
  selected: boolean;
  created_at: string;
  updated_at: string;
}

/** Sanitized calendar-list entry returned to the client. Never carries tokens. */
export interface GoogleCalendarListItem {
  id: string;
  summary: string | null;
  primary: boolean;
  timeZone: string | null;
}
