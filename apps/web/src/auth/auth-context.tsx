import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../lib/env.js";

/**
 * Minimal, real Supabase auth (phase-0 scaffolding, not the final auth UX).
 * The anon key is client-safe by design — RLS is the data boundary — and the
 * resulting access token is what /health calls send as their Bearer header.
 */

export type AuthStatus = "loading" | "unconfigured" | "signed_out" | "signed_in";

export interface AuthState {
  status: AuthStatus;
  client: SupabaseClient | null;
  accessToken: string | null;
  userEmail: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    if (SUPABASE_URL === undefined || SUPABASE_ANON_KEY === undefined) {
      return null;
    }
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }, []);

  const [session, setSession] = useState<Session | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (client === null) {
      setResolved(true);
      return;
    }
    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setResolved(true);
      }
    });
    const { data: subscription } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setResolved(true);
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthState>(() => {
    if (client === null) {
      return { status: "unconfigured", client, accessToken: null, userEmail: null };
    }
    if (!resolved) {
      return { status: "loading", client, accessToken: null, userEmail: null };
    }
    if (session === null) {
      return { status: "signed_out", client, accessToken: null, userEmail: null };
    }
    return {
      status: "signed_in",
      client,
      accessToken: session.access_token,
      userEmail: session.user.email ?? null,
    };
  }, [client, resolved, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return ctx;
}
