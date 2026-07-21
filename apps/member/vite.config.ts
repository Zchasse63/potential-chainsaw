import netlify from "@netlify/vite-plugin-tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// @kelo/member — TanStack Start SSR (plan-member-app §2). Plugin order is
// load-bearing: start first, the Netlify adapter, and the React plugin AFTER
// start. Tests run through the ROOT vitest config, not this file.

/**
 * DEV-ONLY /api proxy (opt-in via KELO_API_ORIGIN).
 *
 * The member client calls the API SAME-ORIGIN (member-core passes origin: ""
 * → /api/v1/member/*). In production apps/member/netlify.toml rewrites /api/*
 * to the primary site. In `vite dev` the Netlify plugin's middleware ALSO
 * applies that rewrite — straight at the unresolvable PRIMARY-SITE-PLACEHOLDER
 * host — so every INTERACTIVE member call (sign-in, account, book, waitlist)
 * 404s locally, while only the SSR loaders (which call the API server-side via
 * KELO_API_ORIGIN) work. That left the signed-in half of the app undevelopable
 * and untestable locally.
 *
 * Vite's own `server.proxy` can't fix it: the Netlify middleware handles /api
 * first. So this plugin is listed FIRST and registers its middleware ahead of
 * Netlify's, forwarding /api/* to KELO_API_ORIGIN — the same origin the SSR
 * loaders use, so dev resolves /api exactly like prod.
 *
 * Dev-server only: never bundled, `vite build` never sees it, and it introduces
 * no Supabase material (invariant #11). Set-Cookie is relayed verbatim so the
 * host-only kmb_ member cookie survives the hop.
 */
function devApiProxy(target: string): Plugin {
  return {
    name: "kelo-dev-api-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (url === undefined || !url.startsWith("/api/")) return next();
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          headers.delete("host");
          headers.delete("connection");
          const upstream = await fetch(`${target}${url}`, {
            method: req.method ?? "GET",
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            redirect: "manual",
          });
          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (lower === "content-encoding" || lower === "content-length" || lower === "set-cookie") return;
            res.setHeader(key, value);
          });
          const setCookie = upstream.headers.getSetCookie();
          if (setCookie.length > 0) res.setHeader("set-cookie", setCookie);
          res.end(Buffer.from(await upstream.arrayBuffer()));
        })().catch((error: unknown) => next(error));
      });
    },
  };
}

const apiOrigin = process.env.KELO_API_ORIGIN;

export default defineConfig({
  plugins: [
    ...(apiOrigin === undefined ? [] : [devApiProxy(apiOrigin)]),
    tanstackStart(),
    netlify(),
    viteReact(),
  ],
});
