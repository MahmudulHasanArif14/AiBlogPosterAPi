import type { Metadata } from "next";
import Link from "next/link";
import { MAX_PAGE_SIZE, listLocations, siteUrl } from "@/lib/posts-repository";

export const revalidate = 600;

export const metadata: Metadata = {
  title: "Content API documentation | Western Cars Content Hub",
  description:
    "How Western Cars websites retrieve published blog articles from the central content platform: endpoints, parameters, pagination, fields, caching, errors and Next.js integration.",
  alternates: { canonical: "/api-docs" },
  openGraph: {
    title: "Western Cars Content API documentation",
    description:
      "Endpoints, parameters, pagination, response fields and integration guidance for the central Western Cars blog content API.",
    type: "website",
  },
};

function Code({ children }: { children: string }) {
  return (
    <pre className="my-3 overflow-x-auto rounded-lg bg-slate-900 p-4 text-[13px] leading-relaxed text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

function Inline({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[0.9em] text-slate-900">
      {children}
    </code>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="mt-12 scroll-mt-6 border-t border-slate-200 pt-8 first:mt-0 first:border-0 first:pt-0"
    >
      <h2 className="mb-3 text-2xl font-bold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: (string | React.ReactNode)[][];
}) {
  return (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-2 border-slate-300">
            {head.map((cell) => (
              <th key={cell} className="py-2 pr-4 font-semibold text-slate-900">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-slate-200 align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2 pr-4 text-slate-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ApiDocsPage() {
  const base = siteUrl();

  // The supported-slug list is read live, so these docs cannot drift from the
  // locations the API actually accepts.
  const locations = await listLocations().catch(() => []);

  const contents = [
    ["overview", "What this platform is"],
    ["endpoints", "Endpoints"],
    ["locations", "Location slugs"],
    ["pagination", "Pagination"],
    ["fields", "Article fields"],
    ["examples", "Example responses"],
    ["errors", "Errors and troubleshooting"],
    ["caching", "Caching and update frequency"],
    ["feeds", "RSS and sitemap"],
    ["nextjs", "Integrating with a Next.js site"],
    ["testing", "Testing requests"],
  ] as const;

  return (
    <main className="mx-auto max-w-4xl bg-white px-6 py-12 text-slate-800 sm:px-10">
      <p className="text-sm font-bold tracking-wide text-teal-700">
        WESTERN CARS · CONTENT HUB
      </p>

      <h1 className="mt-2 text-4xl font-bold text-slate-900">
        Content API documentation
      </h1>

      <p className="mt-4 text-lg leading-relaxed text-slate-600">
        The central blog platform writes and stores articles once, for every
        Western Cars location. Each location&apos;s own website reads the
        articles it needs from this API and renders them as native pages on its
        own domain.
      </p>

      <nav
        aria-label="Contents"
        className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-5"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          On this page
        </h2>

        <ol className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
          {contents.map(([id, label]) => (
            <li key={id}>
              <a className="text-sky-800 hover:underline" href={`#${id}`}>
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section id="overview" title="What this platform is">
        <p className="leading-relaxed">
          This site is the single source of truth for Western Cars blog content.
          A scheduled job generates one new article per day, rotating through the
          enabled locations so each one is covered in turn. Every article passes
          a quality gate before it can be published, and anything the gate
          cannot clear is held for human review instead.
        </p>

        <p className="mt-3 leading-relaxed">
          Consuming websites do not copy articles into their own databases. They
          call this API at request or build time, cache the response, and render
          the listing and article pages themselves. That way an article lives at
          one canonical address centrally, while readers stay on the local
          domain they arrived at.
        </p>

        <div className="mt-4 rounded-lg border-l-4 border-amber-400 bg-amber-50 p-4 text-sm leading-relaxed">
          <strong className="font-semibold">On factual accuracy.</strong> Every
          published article has had its material claims traced to an approved
          source, and those sources are listed with the article. Tracing a claim
          to a source is not the same as proving it true. Fares, timetables and
          service details change; always confirm them with the operator or
          authority before relying on them.
        </div>
      </Section>

      <Section id="endpoints" title="Endpoints">
        <p className="leading-relaxed">
          The public content API is read-only and needs no API key or
          authentication. Generation and administration routes are separate and
          are protected by a server-side secret.
        </p>

        <Table
          head={["Method", "Path", "Returns"]}
          rows={[
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/api/posts</Inline>,
              "A paginated list of published articles, newest first. Optionally filtered to one location.",
            ],
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/api/posts/{"{slug}"}</Inline>,
              "One published article, including its full body text.",
            ],
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/api/locations</Inline>,
              "Every enabled location slug, with how many published articles each has.",
            ],
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/feed.xml</Inline>,
              "RSS 2.0 feed of published articles, optionally filtered by location.",
            ],
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/sitemap.xml</Inline>,
              "Sitemap for the central hub's own article pages.",
            ],
            [
              <Inline key="m">GET</Inline>,
              <Inline key="p">/posts/{"{slug}"}</Inline>,
              "The article rendered on the central hub. This is each article's canonical URL.",
            ],
          ]}
        />

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          Query parameters for <Inline>/api/posts</Inline>
        </h3>

        <Table
          head={["Parameter", "Required", "Default", "Notes"]}
          rows={[
            [
              <Inline key="p">location</Inline>,
              "No",
              "all locations",
              "A location slug. Omit it to list articles for every location.",
            ],
            [
              <Inline key="p">page</Inline>,
              "No",
              "1",
              "Whole number, 1 or more. A page beyond the last returns an empty array, not an error.",
            ],
            [
              <Inline key="p">limit</Inline>,
              "No",
              "10",
              `Whole number from 1 to ${MAX_PAGE_SIZE}. Anything outside that range is a 400.`,
            ],
            [
              <Inline key="p">content</Inline>,
              "No",
              "summary",
              <>
                Either <Inline>summary</Inline> or <Inline>full</Inline>. The
                default omits article bodies to keep listings small; use{" "}
                <Inline>full</Inline> only when you genuinely need every body in
                one call.
              </>,
            ],
          ]}
        />

        <div className="mt-4 rounded-lg border-l-4 border-sky-400 bg-sky-50 p-4 text-sm leading-relaxed">
          <strong className="font-semibold">Getting full article bodies.</strong>{" "}
          The listing endpoint returns summaries. To render an article page,
          follow the <Inline>content_url</Inline> on the listing item, which
          points at <Inline>/api/posts/{"{slug}"}</Inline>. This keeps listing
          responses small and is why the single-article endpoint exists.
        </div>
      </Section>

      <Section id="locations" title="Location slugs">
        <p className="leading-relaxed">
          A slug is lowercase, with words joined by single hyphens, matching{" "}
          <Inline>^[a-z0-9]+(?:-[a-z0-9]+)*$</Inline>. A slug in any other shape
          is a <Inline>400 invalid_location</Inline>; a correctly shaped slug
          that is not an enabled location is a{" "}
          <Inline>404 unknown_location</Inline>.
        </p>

        {locations.length > 0 ? (
          <>
            <p className="mt-4 leading-relaxed">
              These {locations.length} locations are enabled right now. This list
              is read from the database when the page is built, so it matches
              what the API accepts.
            </p>

            <Table
              head={["Slug", "Name", "Published articles"]}
              rows={locations.map((location) => [
                <Inline key={location.slug}>{location.slug}</Inline>,
                location.name,
                String(location.published_posts),
              ])}
            />
          </>
        ) : (
          <p className="mt-4 leading-relaxed text-slate-600">
            The live location list could not be loaded. Call{" "}
            <Inline>/api/locations</Inline> for the current set.
          </p>
        )}
      </Section>

      <Section id="pagination" title="Pagination">
        <p className="leading-relaxed">
          Articles are ordered by publication date, newest first, with the
          article id as a tie-breaker. The tie-breaker matters: without it, two
          articles published in the same instant could swap places between
          requests and appear twice, or not at all, as a reader pages through.
        </p>

        <p className="mt-3 leading-relaxed">
          Every listing response carries this metadata alongside the{" "}
          <Inline>data</Inline> array:
        </p>

        <Table
          head={["Field", "Type", "Meaning"]}
          rows={[
            [<Inline key="f">page</Inline>, "number", "The page that was returned."],
            [<Inline key="f">limit</Inline>, "number", "Page size that was applied."],
            [
              <Inline key="f">total</Inline>,
              "number",
              "Total published articles matching the filter, across all pages.",
            ],
            [
              <Inline key="f">totalPages</Inline>,
              "number",
              "Number of pages at this page size. 0 when there are no articles.",
            ],
            [
              <Inline key="f">hasPreviousPage</Inline>,
              "boolean",
              "Whether a previous page exists.",
            ],
            [
              <Inline key="f">hasNextPage</Inline>,
              "boolean",
              "Whether a further page exists. Use this to decide whether to render a Next link.",
            ],
            [
              <Inline key="f">location</Inline>,
              "object or null",
              "The resolved location, or null when no filter was applied.",
            ],
            [
              <Inline key="f">contentIncluded</Inline>,
              "boolean",
              "Whether article bodies are present in this response.",
            ],
          ]}
        />
      </Section>

      <Section id="fields" title="Article fields">
        <Table
          head={["Field", "Type", "Meaning"]}
          rows={[
            [<Inline key="f">id</Inline>, "string (uuid)", "Stable identifier."],
            [<Inline key="f">title</Inline>, "string", "Article headline."],
            [
              <Inline key="f">slug</Inline>,
              "string",
              "URL-safe identifier. Use it for your own /blog/{slug}/ route.",
            ],
            [
              <Inline key="f">excerpt</Inline>,
              "string",
              "One- or two-sentence summary, for blog cards.",
            ],
            [
              <Inline key="f">content</Inline>,
              "string",
              "Full body as plain text. Paragraphs are separated by a blank line. Present only when requested.",
            ],
            [
              <Inline key="f">content_url</Inline>,
              "string",
              "Absolute URL of the single-article endpoint for this article.",
            ],
            [
              <Inline key="f">meta_description</Inline>,
              "string",
              "Ready-to-use meta description, 100 to 160 characters.",
            ],
            [
              <Inline key="f">canonical_url</Inline>,
              "string",
              "The article's canonical address on this central hub. See the note below.",
            ],
            [<Inline key="f">url</Inline>, "string", "Alias of canonical_url."],
            [
              <Inline key="f">published_at</Inline>,
              "string (ISO 8601) or null",
              "When the article was published.",
            ],
            [
              <Inline key="f">updated_at</Inline>,
              "string (ISO 8601) or null",
              "When the article last changed. Use it for your own lastmod.",
            ],
            [
              <Inline key="f">location</Inline>,
              "object or null",
              "{ slug, name } of the location the article was written for.",
            ],
            [<Inline key="f">location_id</Inline>, "string (uuid)", "Internal location id."],
            [<Inline key="f">author</Inline>, "string or null", "Byline."],
            [<Inline key="f">category</Inline>, "string or null", "A single short category phrase."],
            [<Inline key="f">tags</Inline>, "string[]", "Up to six short topic tags. Always an array."],
            [
              <Inline key="f">reading_minutes</Inline>,
              "number or null",
              "Estimated reading time at 220 words per minute.",
            ],
            [
              <Inline key="f">sources</Inline>,
              "string[]",
              "Approved source URLs the article's factual claims were traced to. Worth displaying.",
            ],
            [
              <Inline key="f">image_url</Inline>,
              "string or null",
              "Featured image. Always check for null: not every article has one.",
            ],
            [
              <Inline key="f">image_alt</Inline>,
              "string or null",
              "Alt text. Fall back to the title if absent.",
            ],
            [
              <Inline key="f">image_credit</Inline>,
              "string or null",
              "Attribution text. You must display this if you display the image.",
            ],
            [
              <Inline key="f">image_source_url</Inline>,
              "string or null",
              "Where the image came from.",
            ],
            [
              <Inline key="f">image_license</Inline>,
              "string or null",
              "Licence name. Display it alongside the credit.",
            ],
            [
              <Inline key="f">image_license_url</Inline>,
              "string or null",
              "Link to the licence terms.",
            ],
            [
              <Inline key="f">image_provider</Inline>,
              "string or null",
              "Which library the image came from.",
            ],
            [
              <Inline key="f">image_width</Inline>,
              "number or null",
              "Intrinsic width in pixels. Pass it to next/image to avoid layout shift.",
            ],
            [
              <Inline key="f">image_height</Inline>,
              "number or null",
              "Intrinsic height in pixels.",
            ],
            [
              <Inline key="f">image_mime</Inline>,
              "string or null",
              "Image media type.",
            ],
          ]}
        />

        <div className="mt-4 rounded-lg border-l-4 border-rose-400 bg-rose-50 p-4 text-sm leading-relaxed">
          <strong className="font-semibold">
            Do not reuse canonical_url as your canonical tag.
          </strong>{" "}
          When you render an article at{" "}
          <Inline>https://www.westerncarsbrighton.co.uk/blog/my-slug/</Inline>,
          that is the URL your canonical tag, Open Graph URL and sitemap entry
          must use. Pointing your canonical at the central hub tells search
          engines to ignore your page entirely. Treat{" "}
          <Inline>canonical_url</Inline> as information about where the article
          lives centrally, not as markup to copy.
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          Internal review data — quality scores, failure reasons, reviewer notes,
          verification records and draft articles — is never returned by this
          API. Only published articles are reachable.
        </p>
      </Section>

      <Section id="examples" title="Example responses">
        <h3 className="text-lg font-semibold text-slate-900">
          Listing: <Inline>GET /api/posts?location=brighton&amp;page=1&amp;limit=2</Inline>
        </h3>

        <Code>{`{
  "data": [
    {
      "id": "7c1f0e6a-2b44-4f1e-9d31-2a9f5b7c8e10",
      "title": "Getting from Brighton Station to Gatwick without rushing",
      "slug": "brighton-station-to-gatwick-without-rushing",
      "excerpt": "What to check before you travel, and how to build a margin into an early airport run.",
      "meta_description": "Practical advice on planning a Brighton to Gatwick airport journey, including what to check before you set off and how much margin to allow.",
      "canonical_url": "${base}/posts/brighton-station-to-gatwick-without-rushing",
      "url": "${base}/posts/brighton-station-to-gatwick-without-rushing",
      "content_url": "${base}/api/posts/brighton-station-to-gatwick-without-rushing",
      "published_at": "2026-10-20T06:12:44.182Z",
      "updated_at": "2026-10-20T06:12:44.182Z",
      "location": { "slug": "brighton", "name": "Brighton" },
      "location_id": "1b9d...",
      "author": "Western Cars Content Team",
      "category": "Airport transfers",
      "tags": ["gatwick", "airport transfers", "brighton"],
      "reading_minutes": 5,
      "sources": [
        "https://www.gatwickairport.com/",
        "https://www.nationalrail.co.uk/"
      ],
      "image_url": "https://images.pexels.com/photos/1004/...jpeg",
      "image_alt": "Brighton: airport transfer planning",
      "image_credit": "Photo by A. Photographer on Pexels",
      "image_source_url": "https://www.pexels.com/photo/example-1004/",
      "image_license": "Pexels License",
      "image_license_url": "https://www.pexels.com/license/",
      "image_provider": "Pexels",
      "image_width": 1920,
      "image_height": 1080,
      "image_mime": "image/jpeg"
    }
  ],
  "page": 1,
  "limit": 2,
  "total": 7,
  "totalPages": 4,
  "hasPreviousPage": false,
  "hasNextPage": true,
  "location": { "slug": "brighton", "name": "Brighton" },
  "contentIncluded": false
}`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          Single article: <Inline>GET /api/posts/{"{slug}"}</Inline>
        </h3>

        <Code>{`{
  "data": {
    "id": "7c1f0e6a-2b44-4f1e-9d31-2a9f5b7c8e10",
    "title": "Getting from Brighton Station to Gatwick without rushing",
    "slug": "brighton-station-to-gatwick-without-rushing",
    "content": "First paragraph of the article.\\n\\nSecond paragraph.\\n\\nThird paragraph.",
    "...": "all the listing fields are present too"
  }
}`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          Locations: <Inline>GET /api/locations</Inline>
        </h3>

        <Code>{`{
  "data": [
    { "slug": "brighton", "name": "Brighton", "published_posts": 7, "last_published_at": "2026-10-20T06:12:44.182Z" },
    { "slug": "crawley", "name": "Crawley", "published_posts": 3, "last_published_at": "2026-10-17T05:03:11.004Z" }
  ],
  "total": 13
}`}</Code>
      </Section>

      <Section id="errors" title="Errors and troubleshooting">
        <p className="leading-relaxed">
          Errors return a JSON body with a human-readable{" "}
          <Inline>error</Inline> string and a stable machine-readable{" "}
          <Inline>code</Inline>. Branch on <Inline>code</Inline>, never on the
          message text.
        </p>

        <Code>{`{
  "error": "The limit parameter must be a whole number between 1 and ${MAX_PAGE_SIZE}.",
  "code": "invalid_limit",
  "details": { "received": "500", "maximum": ${MAX_PAGE_SIZE} }
}`}</Code>

        <Table
          head={["Status", "Code", "Cause and fix"]}
          rows={[
            [
              "400",
              <Inline key="c">invalid_location</Inline>,
              "The location parameter is not a lowercase hyphenated slug. Check for spaces, capitals or underscores.",
            ],
            [
              "400",
              <Inline key="c">invalid_page</Inline>,
              "page was not a whole number of 1 or more. Decimals and strings are rejected rather than coerced.",
            ],
            [
              "400",
              <Inline key="c">invalid_limit</Inline>,
              `limit was outside 1 to ${MAX_PAGE_SIZE}. Page through with several requests instead of raising the limit.`,
            ],
            [
              "400",
              <Inline key="c">invalid_content_mode</Inline>,
              "content was neither 'summary' nor 'full'.",
            ],
            [
              "404",
              <Inline key="c">unknown_location</Inline>,
              "The slug is well formed but is not an enabled location. Check /api/locations.",
            ],
            [
              "404",
              <Inline key="c">post_not_found</Inline>,
              "No published article has that slug. Drafts and articles held for review also return this, deliberately.",
            ],
            [
              "500",
              <Inline key="c">server_error</Inline>,
              "Something failed on our side. The request is safe to retry; back off before retrying.",
            ],
          ]}
        />

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          An empty listing is not an error
        </h3>

        <p className="leading-relaxed">
          A valid location with no published articles yet returns{" "}
          <Inline>200</Inline> with an empty <Inline>data</Inline> array and{" "}
          <Inline>total: 0</Inline>. Requesting a page past the last page behaves
          the same way. Your blog listing needs a real empty state for both.
        </p>
      </Section>

      <Section id="caching" title="Caching and update frequency">
        <p className="leading-relaxed">
          One new article is generated per day across the whole platform,
          rotating through the locations, so any single location gains an article
          every couple of weeks. There is no benefit in polling frequently.
        </p>

        <Table
          head={["Response", "Cache-Control", "In practice"]}
          rows={[
            [
              "Published content endpoints",
              <Inline key="c">public, s-maxage=60, stale-while-revalidate=300</Inline>,
              "Edge-cached for 60 seconds, then served stale while refreshing for up to 5 minutes.",
            ],
            [
              "RSS feed",
              <Inline key="c">public, s-maxage=300, stale-while-revalidate=900</Inline>,
              "Refreshed at most every 5 minutes.",
            ],
            ["Errors", <Inline key="c">no-store</Inline>, "Never cached."],
          ]}
        />

        <p className="mt-3 leading-relaxed">
          Internally, the cached database reads are tagged and cleared the moment
          an article is published, so the only remaining delay is the edge cache.
          A newly published article is visible within about a minute.
        </p>

        <p className="mt-3 leading-relaxed">
          On your own site, revalidate every hour or so. That is far more often
          than content actually changes, and it keeps your pages fast and your
          request volume negligible.
        </p>
      </Section>

      <Section id="feeds" title="RSS and sitemap">
        <Table
          head={["URL", "Purpose"]}
          rows={[
            [
              <Inline key="u">{`${base}/feed.xml`}</Inline>,
              "RSS 2.0, up to 50 most recent published articles across all locations.",
            ],
            [
              <Inline key="u">{`${base}/feed.xml?location=brighton`}</Inline>,
              "The same feed filtered to one location.",
            ],
            [
              <Inline key="u">{`${base}/sitemap.xml`}</Inline>,
              "Sitemap of this hub's own pages only.",
            ],
          ]}
        />

        <div className="mt-4 rounded-lg border-l-4 border-rose-400 bg-rose-50 p-4 text-sm leading-relaxed">
          <strong className="font-semibold">Keep the two sitemaps separate.</strong>{" "}
          Do not add this hub&apos;s article URLs to your site&apos;s sitemap, and
          do not add your URLs to this one. Each sitemap lists only URLs on its
          own domain. Mixing them makes the two copies of an article compete in
          search results.
        </div>
      </Section>

      <Section id="nextjs" title="Integrating with a Next.js site">
        <h3 className="text-lg font-semibold text-slate-900">
          1. Environment variables
        </h3>

        <p className="leading-relaxed">
          No credentials are needed. Two settings keep the integration tidy:
        </p>

        <Code>{`# .env.local on the consuming website
CONTENT_API_BASE_URL=${base}
CONTENT_LOCATION_SLUG=brighton`}</Code>

        <p className="text-sm leading-relaxed text-slate-600">
          Neither needs the <Inline>NEXT_PUBLIC_</Inline> prefix: fetch the API
          on the server so responses are cached once per deployment rather than
          once per visitor.
        </p>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          2. A typed client
        </h3>

        <Code>{`// lib/content-api.ts
const BASE = process.env.CONTENT_API_BASE_URL ?? "${base}";
const LOCATION = process.env.CONTENT_LOCATION_SLUG ?? "brighton";

export type ContentPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content?: string | null;
  meta_description: string;
  canonical_url: string;
  content_url: string;
  published_at: string | null;
  updated_at: string | null;
  location: { slug: string; name: string } | null;
  author: string | null;
  category: string | null;
  tags: string[];
  reading_minutes: number | null;
  sources: string[];
  image_url: string | null;
  image_alt: string | null;
  image_credit: string | null;
  image_license: string | null;
  image_license_url: string | null;
  image_source_url: string | null;
  image_width: number | null;
  image_height: number | null;
};

export type PostsPage = {
  data: ContentPost[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};

export const PAGE_SIZE = 9;

export async function fetchPostsPage(page: number): Promise<PostsPage> {
  const url = new URL("/api/posts", BASE);
  url.searchParams.set("location", LOCATION);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_SIZE));

  const res = await fetch(url, { next: { revalidate: 3600, tags: ["blog"] } });

  if (!res.ok) {
    // Let the caller decide between an empty state and an error state.
    throw new Error(\`content_api_\${res.status}\`);
  }

  return res.json();
}

export async function fetchPost(slug: string): Promise<ContentPost | null> {
  const res = await fetch(new URL(\`/api/posts/\${slug}\`, BASE), {
    next: { revalidate: 3600, tags: ["blog"] },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(\`content_api_\${res.status}\`);

  const body = await res.json();
  return body.data;
}`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          3. Crawlable paginated listing
        </h3>

        <p className="leading-relaxed">
          Use real routes rather than a client-side page parameter, so each page
          has its own URL that works without JavaScript:{" "}
          <Inline>/blog/</Inline> for page one and{" "}
          <Inline>/blog/page/2/</Inline> onward. Point page one&apos;s canonical
          at <Inline>/blog/</Inline>, never at <Inline>/blog/page/1/</Inline>.
        </p>

        <Code>{`// app/blog/page.tsx                  -> page 1
// app/blog/page/[page]/page.tsx      -> pages 2+
// Both render the same component.

import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchPostsPage } from "@/lib/content-api";

export const revalidate = 3600;

export default async function BlogListing({ page = 1 }: { page?: number }) {
  let result;

  try {
    result = await fetchPostsPage(page);
  } catch {
    return <p>Our blog is temporarily unavailable. Please try again shortly.</p>;
  }

  // Page 2+ with nothing on it is a genuine 404, not an empty state.
  if (page > 1 && result.data.length === 0) notFound();

  if (result.data.length === 0) {
    return <p>New articles are on the way. Please check back soon.</p>;
  }

  return (
    <>
      <ul>
        {result.data.map((post) => (
          <li key={post.id}>
            <Link href={\`/blog/\${post.slug}/\`}>{post.title}</Link>
            <p>{post.excerpt}</p>
            <time dateTime={post.published_at ?? undefined}>
              {post.published_at
                ? new Date(post.published_at).toLocaleDateString("en-GB")
                : null}
            </time>
          </li>
        ))}
      </ul>

      <nav aria-label="Blog pagination">
        {result.hasPreviousPage ? (
          <Link
            rel="prev"
            href={page === 2 ? "/blog/" : \`/blog/page/\${page - 1}/\`}
          >
            Previous
          </Link>
        ) : null}

        {Array.from({ length: result.totalPages }, (_, i) => i + 1).map((n) =>
          n === page ? (
            <span key={n} aria-current="page">{n}</span>
          ) : (
            <Link key={n} href={n === 1 ? "/blog/" : \`/blog/page/\${n}/\`}>{n}</Link>
          ),
        )}

        {result.hasNextPage ? (
          <Link rel="next" href={\`/blog/page/\${page + 1}/\`}>Next</Link>
        ) : null}
      </nav>
    </>
  );
}`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          4. The article page
        </h3>

        <p className="leading-relaxed">
          Render the body by splitting <Inline>content</Inline> on blank lines.
          It is plain text, so never pass it to{" "}
          <Inline>dangerouslySetInnerHTML</Inline>.
        </p>

        <Code>{`// app/blog/[slug]/page.tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchPost } from "@/lib/content-api";

export const revalidate = 3600;

const SITE = "https://www.westerncarsbrighton.co.uk";

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const post = await fetchPost(slug);

  if (!post) return { title: "Article not found", robots: { index: false } };

  // The canonical is YOUR url, because this is where the page is served.
  const canonical = \`\${SITE}/blog/\${post.slug}/\`;

  return {
    title: post.title,
    description: post.meta_description,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.meta_description,
      url: canonical,
      publishedTime: post.published_at ?? undefined,
      modifiedTime: post.updated_at ?? undefined,
      images: post.image_url ? [post.image_url] : undefined,
    },
  };
}

export default async function ArticlePage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const post = await fetchPost(slug);

  if (!post) notFound();

  const paragraphs = (post.content ?? "")
    .split(/\\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.excerpt}</p>

      {post.image_url ? (
        <figure>
          {/* next/image needs the hostname in next.config remotePatterns */}
          <img
            src={post.image_url}
            alt={post.image_alt ?? post.title}
            width={post.image_width ?? undefined}
            height={post.image_height ?? undefined}
          />
          <figcaption>
            {post.image_credit} · {post.image_license}
          </figcaption>
        </figure>
      ) : null}

      {paragraphs.map((p, i) => <p key={i}>{p}</p>)}

      {post.sources.length > 0 ? (
        <section>
          <h2>Sources</h2>
          <ul>
            {post.sources.map((s) => (
              <li key={s}><a href={s} rel="nofollow noopener">{s}</a></li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          5. Images
        </h3>

        <p className="leading-relaxed">
          Featured images are served from <Inline>images.pexels.com</Inline>. To
          use <Inline>next/image</Inline>, allow that host:
        </p>

        <Code>{`// next.config.ts
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.pexels.com", pathname: "/photos/**" },
    ],
  },
};`}</Code>

        <p className="text-sm leading-relaxed text-slate-600">
          If you display an image you must display its{" "}
          <Inline>image_credit</Inline> and <Inline>image_license</Inline>. Both
          are supplied with every article that has one.
        </p>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">
          6. Your own sitemap
        </h3>

        <Code>{`// app/sitemap.ts on the consuming website
import type { MetadataRoute } from "next";
import { fetchPostsPage, PAGE_SIZE } from "@/lib/content-api";

const SITE = "https://www.westerncarsbrighton.co.uk";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const first = await fetchPostsPage(1);
  const posts = [...first.data];

  for (let page = 2; page <= first.totalPages; page += 1) {
    posts.push(...(await fetchPostsPage(page)).data);
  }

  return [
    { url: \`\${SITE}/blog/\`, lastModified: new Date() },
    // Listing pages 2+ are crawlable, so list them too.
    ...Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => ({
      url: \`\${SITE}/blog/page/\${i + 2}/\`,
      lastModified: new Date(),
    })),
    ...posts.map((post) => ({
      url: \`\${SITE}/blog/\${post.slug}/\`,
      lastModified: new Date(post.updated_at ?? post.published_at ?? Date.now()),
    })),
  ];
}`}</Code>
      </Section>

      <Section id="testing" title="Testing requests">
        <h3 className="text-lg font-semibold text-slate-900">Browser</h3>

        <p className="leading-relaxed">
          Open any endpoint directly — they are all plain{" "}
          <Inline>GET</Inline> requests with no authentication:
        </p>

        {/* These are JSON API endpoints, not pages, so a plain anchor is
            correct here: next/link would prefetch them as route payloads. */}
        {/* eslint-disable @next/next/no-html-link-for-pages */}
        <ul className="my-3 ml-5 list-disc space-y-1 text-sm">
          <li>
            <a
              className="text-sky-800 hover:underline"
              href="/api/posts?location=brighton&page=1&limit=10"
            >
              /api/posts?location=brighton&amp;page=1&amp;limit=10
            </a>
          </li>
          <li>
            <a className="text-sky-800 hover:underline" href="/api/locations">
              /api/locations
            </a>
          </li>
          <li>
            <a
              className="text-sky-800 hover:underline"
              href="/feed.xml?location=brighton"
            >
              /feed.xml?location=brighton
            </a>
          </li>
        </ul>
        {/* eslint-enable @next/next/no-html-link-for-pages */}

        <h3 className="mt-6 text-lg font-semibold text-slate-900">curl</h3>

        <Code>{`curl -s "${base}/api/posts?location=brighton&page=1&limit=5" | jq .

# Just the slugs
curl -s "${base}/api/posts?location=brighton&limit=50" | jq -r '.data[].slug'

# One article with its body
curl -s "${base}/api/posts/<slug>" | jq '.data.content'`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">PowerShell</h3>

        <Code>{`$base = "${base}"
$res = Invoke-RestMethod -Uri "$base/api/posts?location=brighton&page=1&limit=5"

"Total: $($res.total)  Pages: $($res.totalPages)"
$res.data | Select-Object title, slug, published_at | Format-Table -AutoSize

# One article
$post = Invoke-RestMethod -Uri "$base/api/posts/$($res.data[0].slug)"
$post.data.content`}</Code>

        <h3 className="mt-6 text-lg font-semibold text-slate-900">JavaScript</h3>

        <Code>{`const base = "${base}";

const params = new URLSearchParams({
  location: "brighton",
  page: "1",
  limit: "10",
});

const res = await fetch(\`\${base}/api/posts?\${params}\`);

if (!res.ok) {
  const { code, error } = await res.json();
  throw new Error(\`\${code}: \${error}\`);
}

const { data, total, totalPages, hasNextPage } = await res.json();
console.log({ returned: data.length, total, totalPages, hasNextPage });`}</Code>
      </Section>

      <footer className="mt-14 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <Link className="text-sky-800 hover:underline" href="/">
          Back to the content hub
        </Link>
        <p className="mt-2">
          The public content API is read-only and unauthenticated. Generation and
          administration endpoints require a server-side secret and are not part
          of this documentation.
        </p>
      </footer>
    </main>
  );
}
