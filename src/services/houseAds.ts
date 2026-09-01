import { query } from "../db/pool.js";

export type HouseAd = {
  id: number;
  title: string;
  imageUrl: string;
  link: string;
};

type HouseAdRow = {
  id: number;
  title: string;
  image_url: string;
  link: string;
};

/**
 * Sponsor creatives for the home feed's ad slot. There is no advertiser
 * admin UI yet - rows are inserted directly in Postgres as sponsorships are
 * sold, the same house-ads-as-inventory approach as award_programs.
 */
export async function getActiveHouseAds(): Promise<HouseAd[]> {
  const result = await query<HouseAdRow>(
    "SELECT id, title, image_url, link FROM house_ads WHERE is_active = true ORDER BY sort_order"
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    link: row.link
  }));
}
