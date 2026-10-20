import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { PLATFORM_LOCALE, PLATFORM_TIMEZONE } from "@/lib/config";
import { getPublishedPost, siteUrl } from "@/lib/posts-repository";

export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

function formatDate(value: string | null) {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleDateString(PLATFORM_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: PLATFORM_TIMEZONE,
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);

  if (!post) {
    return { title: "Article not found", robots: { index: false } };
  }

  return {
    title: post.title,
    description: post.meta_description,
    alternates: { canonical: post.canonical_url },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.meta_description,
      url: post.canonical_url,
      siteName: "Western Cars Content Hub",
      locale: "en_GB",
      publishedTime: post.published_at ?? undefined,
      modifiedTime: post.updated_at ?? undefined,
      ...(post.image_url
        ? {
            images: [
              {
                url: post.image_url,
                width: post.image_width ?? undefined,
                height: post.image_height ?? undefined,
                alt: post.image_alt ?? post.title,
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: post.image_url ? "summary_large_image" : "summary",
      title: post.title,
      description: post.meta_description,
      ...(post.image_url ? { images: [post.image_url] } : {}),
    },
  };
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);

  if (!post) {
    notFound();
  }

  const paragraphs = (post.content ?? "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const published = formatDate(post.published_at);
  const updated = formatDate(post.updated_at);

  // Article structured data only. No review or rating markup: there is nothing
  // here that would make such a claim truthful.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.meta_description,
    mainEntityOfPage: { "@type": "WebPage", "@id": post.canonical_url },
    url: post.canonical_url,
    inLanguage: "en-GB",
    datePublished: post.published_at ?? undefined,
    dateModified: post.updated_at ?? undefined,
    author: { "@type": "Organization", name: post.author ?? "Western Cars" },
    publisher: { "@type": "Organization", name: "Western Cars", url: siteUrl() },
    ...(post.image_url ? { image: [post.image_url] } : {}),
    ...(post.location
      ? { contentLocation: { "@type": "Place", name: post.location.name } }
      : {}),
    ...(post.sources.length > 0 ? { citation: post.sources } : {}),
  };

  return (
    <main
      style={{
        maxWidth: 780,
        margin: "48px auto",
        padding: 24,
        background: "white",
        color: "#0f172a",
        borderRadius: 12,
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link href="/">Western Cars Content Hub</Link>

      <p style={{ color: "#64748b" }}>
        {post.location ? `${post.location.name} · ` : ""}
        {published ? `Published ${published}` : ""}
        {updated && updated !== published ? ` · Updated ${updated}` : ""}
        {post.reading_minutes ? ` · ${post.reading_minutes} min read` : ""}
      </p>

      <h1 style={{ fontSize: 38, lineHeight: 1.15 }}>{post.title}</h1>

      <p style={{ fontSize: 20, color: "#475569" }}>{post.excerpt}</p>

      {post.image_url ? (
        <figure style={{ margin: "28px 0" }}>
          <Image
            width={1200}
            height={675}
            sizes="(max-width: 768px) 100vw, 1200px"
            priority
            src={post.image_url}
            alt={post.image_alt ?? post.title}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              maxHeight: 520,
              objectFit: "cover",
              borderRadius: 12,
            }}
          />

          <figcaption
            style={{
              marginTop: 8,
              fontSize: 12,
              lineHeight: 1.6,
              color: "#64748b",
            }}
          >
            {post.image_credit ?? "Image creator not specified"}
            {" · "}
            {post.image_license ?? "Licence information"}
            {post.image_license_url ? (
              <>
                {" · "}
                <a
                  href={post.image_license_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Licence details
                </a>
              </>
            ) : null}
            {post.image_source_url ? (
              <>
                {" · "}
                <a
                  href={post.image_source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Image source
                </a>
              </>
            ) : null}
          </figcaption>
        </figure>
      ) : null}

      <article>
        {paragraphs.map((paragraph, index) => (
          <p key={index} style={{ lineHeight: 1.8, marginBottom: 20 }}>
            {paragraph}
          </p>
        ))}
      </article>

      {post.sources.length > 0 ? (
        <section
          style={{
            marginTop: 36,
            paddingTop: 20,
            borderTop: "1px solid #e2e8f0",
          }}
        >
          <h2 style={{ fontSize: 18 }}>Sources</h2>

          <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
            These are the approved references the factual statements in this
            article were traced to. They identify where the information comes
            from; always check the operator or authority directly before you
            travel.
          </p>

          <ul style={{ fontSize: 14, lineHeight: 1.8 }}>
            {post.sources.map((source) => (
              <li key={source}>
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {source}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
