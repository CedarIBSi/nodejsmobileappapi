const entityPattern = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;

/**
 * The one entity map for the API. services/wordpress.ts re-exports
 * decodeEntities from here since 2026-10-05; it used to hold a six-entry map
 * of its own, which left "&hellip;", "&ndash;" and curly quotes on the page
 * as literal text in excerpts and titles.
 */
const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  ndash: "–",
  nbsp: " ",
  quot: '"',
  rdquo: "”",
  rsquo: "’"
};

export function decodeEntities(value: string): string {
  return value.replace(entityPattern, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

/**
 * Collapses CMS free text to one clean line: entities decoded, hard line breaks
 * and runs of spaces folded away, empty results reported as null rather than an
 * empty string. Titles in db_white_paper_data are typed by hand and several
 * carry a newline mid-sentence, so doing this once in the API keeps every
 * client from solving it separately.
 */
export function toSingleLine(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  return text || null;
}
