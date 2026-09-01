-- Galaxy screen copy. Not fetched live: this server's outbound requests to
-- WordPress are blocked by Cloudflare bot protection (TLS fingerprinting),
-- unaffected by IP allowlisting - see WORDPRESS_BYPASS_HEADER in config.ts.
-- Content is captured once from a client that isn't blocked (curl.exe or a
-- browser) and loaded here via `npm run seed:galaxy`, then served from this
-- table instead of requiring WordPress to be reachable on every request.
CREATE TABLE IF NOT EXISTS galaxy_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title text NOT NULL,
  body text NOT NULL,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
