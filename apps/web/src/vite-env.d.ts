/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL for the browser (anon-key) auth client. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key — safe client-side by design (RLS is the boundary). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** API base path; defaults to /api/v1 (same origin behind Netlify redirects). */
  readonly VITE_API_BASE_URL?: string;
  /** Sentry DSN for the web app; telemetry is a no-op without it (BLOCKERS P0-1). */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
