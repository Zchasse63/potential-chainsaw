import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import appCss from "../styles/app.css?url";

/**
 * The member app HTML shell (plan-member-app §2: thin SSR shell, phone-first).
 * The brand stylesheet is selected here via the app CSS (default brand until
 * owner gate P8-1). No Supabase material, no secrets — the only env the
 * client may ever see is the public set listed in netlify.toml.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // Phone-first: the parking-lot phone is the primary device (§3H).
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Book a session" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
