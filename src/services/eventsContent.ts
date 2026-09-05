import { query } from "../db/pool.js";

export type EventStat = {
  label: string;
  value: string;
};

export type EventSeries = {
  body: string;
  items: string[];
  key: string;
  title: string;
};

export type EventVideo = {
  dateLabel: string | null;
  id: string;
  thumbnailUrl: string | null;
  title: string;
  youtubeId: string;
};

export type EventInsight = {
  id: string;
  summary: string;
  title: string;
  topic: string | null;
};

export type EventsAbout = {
  body: string[];
  heading: string;
  points: string[];
};

export type UpcomingEvent = {
  city: string;
  dateLabel: string;
  featured: boolean;
  id: string;
  imageUrl: string | null;
  registrationEmail: string | null;
  summary: string;
  title: string;
  venue: string | null;
};

export type EventsPage = {
  about: EventsAbout | null;
  insights: EventInsight[];
  intro: string;
  series: EventSeries[];
  stats: EventStat[];
  upcoming: UpcomingEvent[];
  videos: EventVideo[];
};

type EventRow = {
  city: string;
  date_label: string;
  id: string;
  image_url: string | null;
  is_featured: boolean;
  registration_email: string | null;
  summary: string;
  title: string;
  venue: string | null;
};

type EventsPageRow = {
  about: EventsAbout | Record<string, never> | null;
  insights: EventInsight[] | null;
  intro: string;
  series: EventSeries[] | null;
  stats: EventStat[] | null;
  videos: EventVideo[] | null;
};

/**
 * `starts_on >= CURRENT_DATE` is the whole reason an event ever leaves this
 * list: nobody has to remember to unpublish a summit the morning after it
 * runs. An event with no date set is not yet scheduled, so it stays until it
 * is withdrawn by hand.
 *
 * Featured first here as well as in the app, so the raw response reads in the
 * order it is shown.
 */
const upcomingSql = `
  SELECT id, title, summary, date_label, city, venue, image_url,
         is_featured, registration_email
  FROM events
  WHERE is_published AND (starts_on IS NULL OR starts_on >= CURRENT_DATE)
  ORDER BY is_featured DESC, sort_order, starts_on NULLS LAST, id
`;

const pageSql = `
  SELECT intro, about, stats, series, videos, insights
  FROM events_page
  WHERE id = 1
`;

function toAbout(about: EventsPageRow["about"]): EventsAbout | null {
  if (!about || !("body" in about) || !Array.isArray(about.body)) {
    return null;
  }

  return {
    body: about.body,
    heading: about.heading ?? "",
    points: Array.isArray(about.points) ? about.points : []
  };
}

/**
 * The Events screen reads this in one call. Every section changes on the same
 * cadence - a few times a year, when the calendar is set - and the screen
 * shows all of it at once, so splitting it into six endpoints would only buy
 * six ways for the page to half-load.
 *
 * An empty database yields empty sections rather than an error; the app treats
 * a wholly empty payload as a failure and shows its own error state.
 */
export async function getEventsPage(): Promise<EventsPage> {
  const [events, page] = await Promise.all([
    query<EventRow>(upcomingSql),
    query<EventsPageRow>(pageSql)
  ]);

  const content = page.rows[0];

  return {
    about: toAbout(content?.about ?? null),
    insights: content?.insights ?? [],
    intro: content?.intro ?? "",
    series: content?.series ?? [],
    stats: content?.stats ?? [],
    upcoming: events.rows.map((row) => ({
      city: row.city,
      dateLabel: row.date_label,
      featured: row.is_featured,
      id: row.id,
      imageUrl: row.image_url,
      registrationEmail: row.registration_email,
      summary: row.summary,
      title: row.title,
      venue: row.venue
    })),
    videos: content?.videos ?? []
  };
}
