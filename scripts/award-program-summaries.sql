-- Rankings & Awards: replace each programme's long WordPress-derived body with
-- the short summary IBSi supplied. Body text only - sort_order, titles, links
-- and winners_link are left exactly as they are.
--
-- Run by hand in pgAdmin against the Azure database. Deliberately NOT a
-- numbered migration: applying it out-of-band would leave `npm run migrate`
-- believing it was still pending and re-running it later.
--
-- Note for afterwards: `npm run seed:awards` re-scrapes ibsintelligence.com
-- and would write the old long copy straight back over this. Don't run it.

BEGIN;

-- Fail before changing anything if the slugs have moved on. An UPDATE that
-- matches no row changes nothing and reports success, which is the one way
-- this script could look like it worked without having done so.
DO $guard$
DECLARE
  matched integer;
BEGIN
  SELECT count(*) INTO matched
  FROM award_programs
  WHERE slug IN (
    'sales-league-table',
    'ibsi-global-fintech-innovation-awards',
    'ibsi-digital-banking-awards',
    'ibsi-annual-middle-east-banking-excellence-awards-2026'
  );

  IF matched <> 4 THEN
    RAISE EXCEPTION
      'Expected 4 award_programs rows, matched %. Check the table before running this.', matched;
  END IF;
END
$guard$;

UPDATE award_programs SET
  body = $body$IBSi Sales League Table (SLT) has been the industry-acknowledged barometer of global Financial Technology vendor performance for 20+ years, covering 120+ leading technology participants from 150+ countries across 20+ system types. Every year.$body$,
  updated_at = now()
WHERE slug = 'sales-league-table';

UPDATE award_programs SET
  body = $body$IBSi Global FinTech Innovation Awards (GFIA) recognize financial institutions and technology providers delivering measurable impact through technology-led transformation and innovation.$body$,
  updated_at = now()
WHERE slug = 'ibsi-global-fintech-innovation-awards';

UPDATE award_programs SET
  body = $body$IBSi Digital Banking Awards (DBA) recognizing excellence across Digital-Only Banks, Neo and Challenger Banks, Digital-First NBFCs, Payments Banks, and digital banking units of traditional financial institutions, as well as the technology providers enabling these transformations.$body$,
  updated_at = now()
WHERE slug = 'ibsi-digital-banking-awards';

UPDATE award_programs SET
  body = $body$IBSi Middle East Banking Excellence Awards (MEBX) celebrate visionary institutions reshaping banking across the region, recognizing leadership in digital transformation and innovation backed by IBSi’s 30+ years of expertise.$body$,
  updated_at = now()
WHERE slug = 'ibsi-annual-middle-east-banking-excellence-awards-2026';

-- Read this back before committing: four short bodies, nothing else touched.
SELECT sort_order, slug, length(body) AS body_chars
FROM award_programs
ORDER BY sort_order;

COMMIT;
