-- The Global FinTech Summits intro outgrew a single line of text: it is now
-- three paragraphs plus a bulleted list of what the forums offer participants.
-- `intro` already holds prose and the app splits it on blank lines, so only
-- the bullets need somewhere new to live.
--
-- Shaped as a bare array rather than mirroring `about` ({heading, body, points}):
-- there is no second heading here, the paragraphs stay in `intro`, and a list
-- of strings is all this is.
ALTER TABLE events_page
  ADD COLUMN IF NOT EXISTS intro_points jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN events_page.intro_points IS
  'Bulleted list shown under intro. ["Strategic insight and peer learning", ...]';

UPDATE events_page SET
  intro = $intro$IBSi hosts an annual series of seven invitation-only thought leadership summits across: London | Dubai | Bahrain | Oman | Kuwait | Mumbai | Singapore

These high-level forums convene senior banking executives, technology leaders, and industry experts. Renowned for substantive, insight-driven discussions, IBSi Summits feature distinguished panelists moderated by IBSi leadership. Since inception, IBSi has delivered over 50 summits, engaging 55+ panelist firms and 45+ sponsors.

For participants, these forums provide:$intro$,
  intro_points = $points$[
  "Strategic insight and peer learning",
  "Brand positioning opportunities",
  "High-value executive networking",
  "Meaningful engagement with prospective clients"
]$points$::jsonb
WHERE id = 1;
