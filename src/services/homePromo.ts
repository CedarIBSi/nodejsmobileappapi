import { query } from "../db/pool.js";

export type HomePromo = {
  eyebrow: string | null;
  link: string;
  title: string;
  /**
   * The app keys a reader's dismissal on this, so editing the row brings the
   * new campaign back for everyone who closed the previous one. Sent as an ISO
   * string rather than a Date so the client has nothing to parse.
   */
  updatedAt: string;
};

type HomePromoRow = {
  eyebrow: string | null;
  link: string;
  title: string;
  updated_at: Date;
};

/**
 * The campaign strip under the lead story, or null when nothing is running.
 *
 * Deliberately nothing to do with `house_ads`: that is sold sponsor inventory,
 * one creative of which the app picks at random for the slot at feed position
 * 3. A campaign placed there would take a paid impression half the time, show
 * nothing the other half, and be drawn under an "Advertisement" label that is
 * the wrong word for IBSi's own programme.
 *
 * Null is the ordinary answer between campaigns, not a failure - the table
 * always holds its single row, and `is_active` is how the team turns the strip
 * off without deleting what they wrote.
 *
 * The title and link guards matter because the migration seeds the row empty:
 * a row activated before anyone filled it in would otherwise render a blank
 * strip that opens nowhere.
 */
export async function getHomePromo(): Promise<HomePromo | null> {
  const result = await query<HomePromoRow>(
    `SELECT eyebrow, title, link, updated_at FROM home_promo
     WHERE id = 1
       AND is_active = true
       AND title <> ''
       AND link <> ''
       AND (ends_at IS NULL OR ends_at > now())`
  );

  const row = result.rows[0];

  if (!row) return null;

  return {
    eyebrow: row.eyebrow,
    link: row.link,
    title: row.title,
    updatedAt: row.updated_at.toISOString()
  };
}
