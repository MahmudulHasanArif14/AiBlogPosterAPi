import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";

export const revalidate = 60;

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = supabaseAdmin();

  const { data: p } = await db
    .from("posts")
    .select(
      [
        "title",
        "slug",
        "excerpt",
        "content",
        "meta_description",
        "published_at",
        "canonical_url",
        "image_url",
        "image_alt",
        "image_credit",
        "image_source_url",
        "image_license",
        "image_license_url",
      ].join(","),
    )
    .eq("slug", slug)
    .eq("status", "published")
    .single();

  if (!p) notFound();

  const paragraphs = p.content
    .split(/\n{2,}/)
    .map((x: string) => x.trim())
    .filter(Boolean);

  const base = (
    process.env.SITE_URL || "https://content.westerncars.co.uk"
  ).replace(/\/$/, "");

  const canonical = p.canonical_url || `${base}/posts/${p.slug}`;

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
      <a href="/">Western Cars Content Hub</a>

      <p style={{ color: "#64748b" }}>
        Published{" "}
        {p.published_at
          ? new Date(p.published_at).toLocaleDateString("en-GB")
          : ""}
      </p>

      <h1 style={{ fontSize: 38, lineHeight: 1.15 }}>{p.title}</h1>

      <p style={{ fontSize: 20, color: "#475569" }}>{p.excerpt}</p>

      {p.image_url && (
        <figure style={{ margin: "28px 0" }}>
          <img
            src={p.image_url}
            alt={p.image_alt || p.title}
            loading="eager"
            fetchPriority="high"
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
            {p.image_credit || "Image creator not specified"}
            {" · "}
            {p.image_license || "Licence information"}
            {p.image_license_url && (
              <>
                {" · "}
                <a
                  href={p.image_license_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Licence details
                </a>
              </>
            )}
            {p.image_source_url && (
              <>
                {" · "}
                <a
                  href={p.image_source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Image source
                </a>
              </>
            )}
          </figcaption>
        </figure>
      )}

      <article>
        {paragraphs.map((paragraph: string, i: number) => (
          <p
            key={i}
            style={{
              lineHeight: 1.8,
              whiteSpace: "pre-wrap",
              marginBottom: 20,
            }}
          >
            {paragraph}
          </p>
        ))}
      </article>

      <link rel="canonical" href={canonical} />
    </main>
  );
}
