import Link from "next/link";
import { PLATFORM_TIMEZONE } from "@/lib/config";
import { listLocations, listPublishedPosts, siteUrl } from "@/lib/posts-repository";

export const revalidate = 300;

export default async function Home() {
  const [locations, recent] = await Promise.all([
    listLocations().catch(() => []),
    listPublishedPosts(null, 1, 6, false).catch(() => null),
  ]);

  const posts = recent && !("notFound" in recent) ? recent.posts : [];
  const total = recent && !("notFound" in recent) ? recent.total : 0;
  const base = siteUrl();

  return (
    <main className="mx-auto max-w-4xl px-6 py-14 sm:px-10">
      <p className="text-sm font-bold tracking-wide text-teal-700">
        WESTERN CARS · CONTENT HUB
      </p>

      <h1 className="mt-2 text-4xl font-bold text-slate-900">
        Central AI Blog Platform
      </h1>

      <p className="mt-4 text-lg leading-relaxed text-slate-600">
        One article a day, generated and quality-checked here, then served to
        every Western Cars location website through a read-only content API.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-3xl font-bold text-slate-900">{total}</p>
          <p className="text-sm text-slate-500">Published articles</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-3xl font-bold text-slate-900">{locations.length}</p>
          <p className="text-sm text-slate-500">Locations in rotation</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-3xl font-bold text-slate-900">1/day</p>
          <p className="text-sm text-slate-500">
            Platform-wide, {PLATFORM_TIMEZONE}
          </p>
        </div>
      </div>

      <section className="mt-10 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-bold text-slate-900">For developers</h2>

        <p className="mt-2 leading-relaxed text-slate-700">
          The public content API is read-only and needs no API key.{" "}
          <Link className="font-semibold text-sky-800 hover:underline" href="/api-docs">
            Read the API documentation
          </Link>{" "}
          for endpoints, pagination, response fields and Next.js integration.
        </p>

        <ul className="mt-4 space-y-1 text-sm text-slate-600">
          <li>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">
              GET /api/posts?location=brighton&amp;page=1&amp;limit=10
            </code>
          </li>
          <li>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">
              GET /api/posts/{"{slug}"}
            </code>
          </li>
          <li>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">
              GET /api/locations
            </code>
          </li>
          <li>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">
              GET /feed.xml?location=brighton
            </code>
          </li>
        </ul>
      </section>

      {posts.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-xl font-bold text-slate-900">Latest articles</h2>

          <ul className="mt-4 space-y-4">
            {posts.map((post) => (
              <li
                key={post.id}
                className="rounded-xl border border-slate-200 bg-white p-5"
              >
                <Link
                  className="text-lg font-semibold text-sky-900 hover:underline"
                  href={`/posts/${post.slug}`}
                >
                  {post.title}
                </Link>

                <p className="mt-1 text-sm text-slate-500">
                  {post.location ? post.location.name : "All locations"}
                  {post.published_at
                    ? ` · ${new Date(post.published_at).toLocaleDateString("en-GB")}`
                    : ""}
                  {post.reading_minutes ? ` · ${post.reading_minutes} min read` : ""}
                </p>

                <p className="mt-2 leading-relaxed text-slate-700">
                  {post.excerpt}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="mt-10 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">
            No published articles yet
          </h2>

          <p className="mt-2 leading-relaxed text-slate-700">
            Articles stay unpublished until every quality and provenance check
            passes. The API returns an empty list with{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">total: 0</code>{" "}
            until then, which consuming websites should render as an empty state
            rather than an error.
          </p>
        </section>
      )}

      <section className="mt-10 rounded-xl border-l-4 border-amber-400 bg-amber-50 p-5 text-sm leading-relaxed">
        <h2 className="font-bold text-slate-900">Publication policy</h2>

        <p className="mt-2">
          An article is published only when it passes structural checks,
          duplicate and near-duplicate detection, placeholder and promotional
          screening, local plausibility checks, and a provenance check that
          traces every material claim to an approved source that still resolves.
          Anything that fails is held for human review with its reasons
          recorded. Tracing a claim to a source is not proof that the claim is
          true.
        </p>
      </section>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          {base} · <Link className="text-sky-800 hover:underline" href="/api-docs">API docs</Link>
          {" · "}
          <a className="text-sky-800 hover:underline" href="/feed.xml">RSS</a>
          {" · "}
          <a className="text-sky-800 hover:underline" href="/sitemap.xml">Sitemap</a>
        </p>
      </footer>
    </main>
  );
}
