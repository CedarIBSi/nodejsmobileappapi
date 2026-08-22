-- White papers follow the journal model: the rows come from the Java CMS table
-- and this API only ever reads them. The table is declared here so a fresh
-- database matches the server, where it already exists.
CREATE TABLE IF NOT EXISTS db_white_paper_data (
  sr_no serial NOT NULL,
  title character varying(5000),
  teaser character varying(5000),
  search_tag character varying(5000),
  image_path character varying(5000),
  redirect_page character varying(5000),
  year integer,
  published_date character varying(5000),
  latest_modification character varying(5000),
  latest_modification_date character varying(5000),
  category character varying(100),
  live_status character varying(50000)
);

-- Columns the API reads, added defensively so an older copy of the CMS table
-- gains them rather than failing every query.
ALTER TABLE db_white_paper_data
  ADD COLUMN IF NOT EXISTS category character varying(100);
ALTER TABLE db_white_paper_data
  ADD COLUMN IF NOT EXISTS live_status character varying(50000);

-- The CMS table ships without a primary key, so sr_no carries no uniqueness
-- guarantee despite being sequence-backed. The API puts sr_no in request paths
-- and signs it into viewing tokens, so a duplicate would give two papers the
-- same identity and let one token open the other's PDF. A unique index states
-- the constraint without the table rewrite that adding a PRIMARY KEY would.
CREATE UNIQUE INDEX IF NOT EXISTS idx_white_paper_sr_no
  ON db_white_paper_data(sr_no);

-- The list filters. At the present row count Postgres will sequential-scan
-- regardless; these exist so the query plan does not degrade as the archive
-- grows the way the journal archive has.
CREATE INDEX IF NOT EXISTS idx_white_paper_category_year
  ON db_white_paper_data(category, year);

-- A paper is servable only when it is marked live and has a PDF filename, so
-- the index covers exactly the rows the API will ever return. live_status is
-- free text entered through the CMS, hence the trim and case fold: the current
-- rows say 'Live', and a stray 'live' or trailing space should not silently
-- retire a paper. Legacy rows predate the column and hold NULL, which reads as
-- not live until they are backfilled.
CREATE INDEX IF NOT EXISTS idx_white_paper_servable
  ON db_white_paper_data(category, year)
  WHERE lower(btrim(live_status)) = 'live'
    AND redirect_page IS NOT NULL
    AND btrim(redirect_page) <> '';
