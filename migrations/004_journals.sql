CREATE TABLE IF NOT EXISTS pv_ibsi_journal_data (
  journal_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sr integer,
  title varchar(5000),
  issue_no varchar(5000),
  month varchar(5000),
  year varchar(5000),
  search_tag varchar(5000),
  image_path varchar(5000),
  redirect_page varchar(5000),
  published_date varchar(5000),
  latest_modification varchar(5000),
  latest_modification_date varchar(5000),
  edition_type text
);

ALTER TABLE pv_ibsi_journal_data
  ADD COLUMN IF NOT EXISTS journal_id bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ibsi_journal_id
  ON pv_ibsi_journal_data(journal_id);
CREATE INDEX IF NOT EXISTS idx_ibsi_journal_year_edition
  ON pv_ibsi_journal_data(year, edition_type);
CREATE INDEX IF NOT EXISTS idx_ibsi_journal_pdf
  ON pv_ibsi_journal_data(redirect_page)
  WHERE redirect_page IS NOT NULL AND btrim(redirect_page) <> '';
