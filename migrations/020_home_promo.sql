-- The campaign strip under the lead story on the home feed.
--
-- A table of its own rather than a column on `house_ads`, so that sold sponsor
-- inventory and IBSi's own campaigns cannot affect each other. The feed slot at
-- position 3 keeps behaving exactly as it does now; nothing in this file
-- touches it.
--
-- One row, enforced. IBSi runs four award programmes on different dates and the
-- strip carries whichever is current, so the team updates this row rather than
-- adding to a list. The CHECK is what makes that safe: without it someone
-- eventually inserts a second row, and which of the two appears becomes a
-- question about ORDER BY rather than about what they meant.
CREATE TABLE IF NOT EXISTS home_promo (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Small uppercase line above the title: "Nominations open", "Now open for
  -- entries". Optional - a campaign that does not need one leaves it null.
  eyebrow text,
  title text NOT NULL,
  link text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  -- Optional safety net. Null means the strip runs until someone turns it off,
  -- which is the normal case when the team is managing it directly. Setting it
  -- to a nomination deadline means the strip goes on that date even if nobody
  -- remembers to come back.
  ends_at timestamptz,
  -- Not bookkeeping. The app keys a reader's "dismiss" on this value, so
  -- editing the row makes the new campaign appear for everyone, including the
  -- readers who closed the previous one. Always bump it when changing the copy:
  --   UPDATE home_promo SET title = '...', updated_at = now() WHERE id = 1;
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seeded inactive and empty of meaning on purpose: the row exists so the team
-- only ever has to UPDATE, never decide between UPDATE and INSERT, but nothing
-- appears on the feed until someone fills it in and activates it.
INSERT INTO home_promo (id, eyebrow, title, link, is_active)
VALUES (1, NULL, '', '', false)
ON CONFLICT (id) DO NOTHING;
