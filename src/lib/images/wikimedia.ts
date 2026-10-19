const API_URL = "https://commons.wikimedia.org/w/api.php";
const MIN_WIDTH = 1200;
const MIN_HEIGHT = 630;

type MetadataValue = {
  value?: string;
};

type ImageInfo = {
  url?: string;
  thumburl?: string;
  mime?: string;
  width?: number;
  height?: number;
  thumbwidth?: number;
  thumbheight?: number;
  extmetadata?: Record<string, MetadataValue>;
};

type CommonsPage = {
  title?: string;
  imageinfo?: ImageInfo[];
};

export type FeaturedImage = {
  image_url: string;
  image_alt: string;
  image_credit: string;
  image_source_url: string;
  image_provider: string;
  image_mime: string;
  image_width: number;
  image_height: number;
  image_license: string;
  image_license_url: string;
};

function plainText(value?: string): string {
  return (value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function allowedImageUrl(value?: string): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname === "upload.wikimedia.org" &&
      !url.username &&
      !url.password &&
      (url.pathname.startsWith("/wikipedia/commons/") ||
        url.pathname.startsWith("/wikipedia/commons/thumb/"))
    );
  } catch {
    return false;
  }
}

function allowedMime(value?: string): boolean {
  return ["image/jpeg", "image/png", "image/webp"].includes(
    (value || "").toLowerCase().split(";")[0].trim(),
  );
}

function allowedLicense(name: string, licenseUrl: string): boolean {
  const combined = `${name} ${licenseUrl}`.toLowerCase();

  // Do not use licences with non-commercial or no-derivatives restrictions.
  if (
    /\bnon[- ]?commercial\b|\bno derivatives\b|\bby-nc\b|\bby-nd\b|\bcc\s*by-nc\b|\bcc\s*by-nd\b/.test(
      combined,
    )
  ) {
    return false;
  }

  // Allow common reusable Creative Commons licences and public-domain works.
  return (
    /\bcc0\b/.test(combined) ||
    /\bpublic domain\b|\bpublic-domain\b/.test(combined) ||
    /\bcc[- ]?by(?:[- ]?sa)?(?:\s|[-/]|$)/.test(combined) ||
    /creativecommons\.org\/licenses\/by(?:-sa)?\//.test(combined)
  );
}

async function imageIsReachable(
  url: string,
  expectedMime: string,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
      headers: {
        "User-Agent": "WesternCarsContentHub/1.0",
      },
    });

    // Reject redirects instead of following an untrusted destination.
    if (!response.ok || response.status >= 300) return false;

    const actualMime = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    return allowedMime(actualMime) && actualMime === expectedMime;
  } catch {
    return false;
  }
}

export async function findWikimediaImage(
  location: string,
  topic: string,
): Promise<FeaturedImage | null> {
  const searchTerm = `${location} ${topic}`
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  if (!searchTerm) return null;

  const api = new URL(API_URL);
  api.search = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `${searchTerm} filetype:bitmap`,
    gsrnamespace: "6",
    gsrwhat: "text",
    gsrlimit: "15",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1600",
  }).toString();

  try {
    const response = await fetch(api, {
      headers: {
        "Api-User-Agent":
          "WesternCarsContentHub/1.0 (https://content.westerncars.co.uk)",
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const pages: CommonsPage[] = payload?.query?.pages || [];

    const candidates = pages
      .map((page) => {
        const info = page.imageinfo?.[0];
        const metadata = info?.extmetadata || {};

        const license = plainText(metadata.LicenseShortName?.value);
        const licenseUrl = plainText(metadata.LicenseUrl?.value);

        const imageUrl = info?.thumburl || info?.url;
        const mime = (info?.mime || "").toLowerCase();

        const width = info?.thumbwidth || info?.width || 0;
        const height = info?.thumbheight || info?.height || 0;

        if (
          !page.title ||
          !allowedImageUrl(imageUrl) ||
          !allowedMime(mime) ||
          width < MIN_WIDTH ||
          height < MIN_HEIGHT ||
          width / height < 1.2 ||
          width / height > 2.2 ||
          !license ||
          !allowedLicense(license, licenseUrl)
        ) {
          return null;
        }

        const description = plainText(metadata.ImageDescription?.value);
        const title = plainText(page.title.replace(/^File:/i, ""));

        const artist = plainText(
          metadata.Artist?.value ||
            metadata.Credit?.value ||
            "Creator not specified",
        );

        return {
          image_url: imageUrl!,
          image_alt: (description || title).slice(0, 250),
          image_credit: artist,
          image_source_url:
            "https://commons.wikimedia.org/wiki/" +
            encodeURIComponent(page.title.replace(/ /g, "_")),
          image_provider: "Wikimedia Commons",
          image_mime: mime,
          image_width: width,
          image_height: height,
          image_license: license,
          image_license_url: licenseUrl,
        } satisfies FeaturedImage;
      })
      .filter((candidate): candidate is FeaturedImage => candidate !== null)
      .slice(0, 4);

    // Validate candidates concurrently, with a short timeout per image.
    const checked = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        reachable: await imageIsReachable(
          candidate.image_url,
          candidate.image_mime,
        ),
      })),
    );

    return checked.find((item) => item.reachable)?.candidate || null;
  } catch {
    // Image search failure must not crash article generation.
    return null;
  }
}
