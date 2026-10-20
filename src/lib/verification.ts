import type { ApprovedSource } from "./quality";

// Live provenance check for the sources an article declares.
//
// This confirms two things, and only these two things:
//   1. every declared source is one an operator approved in content_sources;
//   2. that URL still resolves and is not a dead page.
//
// It does not read the page or confirm that it supports the claim. The honest
// name for what this produces is traceability, which is why the result is
// stored as verification_status rather than anything implying factual proof.

export type SourceOutcome = "ok" | "restricted" | "missing" | "unreachable" | "not_approved";

export type SourceCheck = {
  url: string;
  sourceName: string | null;
  status: number | null;
  outcome: SourceOutcome;
};

export type VerificationResult = {
  status: "verified" | "unverified" | "failed";
  checks: SourceCheck[];
  reasons: string[];
};

const MAX_SOURCES_CHECKED = 8;
const REQUEST_TIMEOUT_MS = 8000;

// A browser-like agent, because several official council and transport sites
// reject obvious automation outright.
const USER_AGENT =
  "Mozilla/5.0 (compatible; WesternCarsContentHub/1.0; +https://content.westerncars.com)";

function matchApproved(url: string, approved: ApprovedSource[]) {
  return (
    approved.find(
      (source) => source.sourceUrl && url === source.sourceUrl,
    ) ??
    approved.find(
      (source) => source.sourceUrl && url.startsWith(source.sourceUrl),
    ) ??
    approved.find((source) => {
      if (!source.sourceUrl) {
        return false;
      }

      try {
        return (
          new URL(url).hostname.toLowerCase() ===
          new URL(source.sourceUrl).hostname.toLowerCase()
        );
      } catch {
        return false;
      }
    }) ??
    null
  );
}

function classify(status: number): SourceOutcome {
  if (status >= 200 && status < 400) {
    return "ok";
  }

  // The host answered and the path exists; it just refuses automation. That
  // still identifies a real source, so it is recorded rather than treated as
  // a dead link.
  if (status === 401 || status === 403 || status === 405 || status === 429) {
    return "restricted";
  }

  if (status === 404 || status === 410) {
    return "missing";
  }

  return "unreachable";
}

async function probe(url: string): Promise<{ status: number | null; outcome: SourceOutcome }> {
  const headers = { "User-Agent": USER_AGENT, Accept: "*/*" };

  for (const method of ["HEAD", "GET"] as const) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Some servers answer HEAD with 405 but serve GET normally.
      if (method === "HEAD" && (response.status === 405 || response.status === 501)) {
        continue;
      }

      return { status: response.status, outcome: classify(response.status) };
    } catch {
      if (method === "GET") {
        return { status: null, outcome: "unreachable" };
      }
    }
  }

  return { status: null, outcome: "unreachable" };
}

export async function verifySources(
  declaredUrls: string[],
  approved: ApprovedSource[],
): Promise<VerificationResult> {
  const unique = [...new Set(declaredUrls.map((url) => url.trim()).filter(Boolean))].slice(
    0,
    MAX_SOURCES_CHECKED,
  );

  if (unique.length === 0) {
    return {
      status: "unverified",
      checks: [],
      reasons: ["no_sources_declared"],
    };
  }

  const checks = await Promise.all(
    unique.map(async (url): Promise<SourceCheck> => {
      const source = matchApproved(url, approved);

      if (!source) {
        return { url, sourceName: null, status: null, outcome: "not_approved" };
      }

      const { status, outcome } = await probe(url);

      return { url, sourceName: source.sourceName, status, outcome };
    }),
  );

  const reasons: string[] = [];

  if (checks.some((check) => check.outcome === "not_approved")) {
    reasons.push("source_not_approved");
  }

  if (checks.some((check) => check.outcome === "missing")) {
    reasons.push("source_url_dead");
  }

  if (checks.some((check) => check.outcome === "unreachable")) {
    reasons.push("source_url_unreachable");
  }

  // A dead or unapproved source is a hard failure: the article is citing
  // something that cannot be stood behind.
  const failed = checks.some(
    (check) => check.outcome === "not_approved" || check.outcome === "missing",
  );

  if (failed) {
    return { status: "failed", checks, reasons };
  }

  // An unreachable host might be a transient network problem on our side
  // rather than a bad citation, so it withholds verification instead of
  // condemning the article.
  if (checks.some((check) => check.outcome === "unreachable")) {
    return { status: "unverified", checks, reasons };
  }

  return { status: "verified", checks, reasons };
}
