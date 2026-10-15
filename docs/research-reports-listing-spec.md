# Research Reports: list the reports from the website

The app's Research Reports screen is changing. At the moment it shows marketing copy
from `research_reports_page`. It will change to a list of the actual reports: each one
shows its cover image, its title and an Express interest button. That data has to come
from the API.

## What the app needs

Add a `reports` array to the existing `GET /v1/research-reports` response:

```json
{
  "researchReports": {
    "title": "Research Reports",
    "intro": "...",
    "deliverables": ["..."],
    "body": "...",
    "reports": [
      {
        "id": 123456,
        "title": "Sales League Table Report 2026",
        "image_url": "https://ibsintelligence.com/wp-content/uploads/2021/04/SLT-2026-Cover-600x849.png"
      }
    ]
  }
}
```

- **Keep `title`, `intro`, `deliverables` and `body`.** Builds already in TestFlight and
  Play read those fields and fail if `intro` is missing. Nothing changes in
  `research_reports_page`.
- `reports` uses the same order as https://ibsintelligence.com/reports-view-all/ with
  the "All" filter (Sales League Table first).
- `image_url` is the cover image. A size around 600px wide is best (WordPress creates a
  `-600x...` version). The covers are portrait, roughly 1:1.41. Return `null` when a
  report has no image, and the app will show a placeholder.
- Leave out prices and store or product-page links. The app will not link to the store
  (see "Why no buy link" below).
- Express interest needs no change: `POST /v1/interest` already accepts any topic up to
  120 characters, and the app will send the report title as the topic.

## Where the data is

The reports are **WooCommerce products** on the WordPress site. The listing page has no
reports in its own HTML. It fetches them after it loads, using:

```
POST https://ibsintelligence.com/wp-admin/admin-ajax.php
action=get_research_items_by_category_for_listing&post_type=POST&cat_slug=0&s=&pg_no=1
```

On 2026-10-15 this returned 12 report cards for page 1. The page reports 2 pages, so
loop over `pg_no` until a page comes back empty. The categories are `bank-wide`,
`retail-banking`, `vendor-reports`, `wealth-management` and `wholesale-banking`
(`cat_slug=0` returns all of them).

### Option A (preferred): WordPress REST, same as podcasts and videos

Use `fetchPostType` in `src/services/wordpress.ts` against the `product` post type, with
`_embed` to get the featured image. This returns clean JSON through the same client,
`WORDPRESS_BYPASS_*` headers and timeout that the other WordPress reads already use.

**Check this first:** I could not confirm from outside that `product` is exposed over
REST, because Cloudflare challenged every `/wp-json/` request. From the server, call
`GET /wp-json/wp/v2/types` and look for `product`. If it is there, use this option and
make sure the list matches the website's order and only includes published reports.

### Option B (fallback): parse the admin-ajax HTML

If `product` is not available over REST, POST to the admin-ajax action above and parse
each card:

```html
<div class='artHorBlo ...'>
  <div class='ahlImg'><img src="...cover.jpg" srcset="... 600w, ..." /></div>
  <div class='ahbCon'><h6>Report title</h6><a href='https://ibsintelligence.com/product/<slug>/'>Know More</a></div>
</div>
```

- Title: the `<h6>` text, with HTML entities decoded (titles contain `&amp;`).
- Image: pick the `600w` entry from `srcset`, or fall back to `src`.
- id: the product slug from the `href`, or a hash of it. It only needs to be stable.

This is more fragile, because a theme change on the site would break it, so return an
empty list rather than an error when the parse finds no cards.

## Caching and failure

- Cache the list in memory for an hour. Reports change a few times a year.
- If WordPress fails and there is a cached copy, serve the cached copy.
- If WordPress fails and there is no cache, return `reports: []` and still return 200
  with the page copy. The screen should still load.
- Keep the existing `Cache-Control: public, max-age=300`.

## Why no buy link

The reports are sold on the website (WooCommerce, prices in GBP). If the app linked out
to buy digital content, it would run into Apple's and Google's payment rules. So the app
offers Express interest only, and IBSi follows up by email.

## Checking it after deploy

```
curl.exe -s https://api.ibsintelligence.com/v1/research-reports
```

`reports` should list every report on the website's "All" view, in the same order, and
every `image_url` should open in a browser.
