import { NextRequest, NextResponse } from "next/server";
import { CURATED_SOURCES } from "@/lib/sources";
import { supabaseAdmin } from "@/lib/supabase";
import { verifySources } from "@/lib/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Current approved-source state, for the operator. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const { data, error } = await supabaseAdmin()
    .from("content_sources")
    .select("source_name,source_url,source_type,approved,notes,updated_at")
    .order("source_name");

  if (error) {
    return NextResponse.json(
      { error: "Could not read content sources", code: "server_error" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    total: data?.length ?? 0,
    approved: (data ?? []).filter((row) => row.approved).length,
    data,
  });
}

/**
 * Sync the curated source list into content_sources, checking each URL first.
 *
 * Idempotent: it upserts on source_url and never deletes an operator's own
 * rows. A URL that 404s or will not resolve is stored but left unapproved, so
 * it cannot be used to justify a claim.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();

  // verifySources only checks URLs it can match to an approved row, so for this
  // bootstrap we treat the curated list itself as the approval set.
  const asApproved = CURATED_SOURCES.map((source) => ({
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    notes: source.notes,
  }));

  // Every curated source is on a different host, so checking them all at once
  // puts no more load on any one of them than checking them one at a time —
  // and it has to fit inside the 60-second function budget. A slow host costs
  // at most one HEAD plus one GET timeout.
  const results = await Promise.all(
    CURATED_SOURCES.map(async (source) => {
      const outcome = await verifySources([source.sourceUrl], asApproved);
      const check = outcome.checks[0];

      return {
        source,
        status: check?.status ?? null,
        outcome: check?.outcome ?? ("unreachable" as const),
      };
    }),
  );

  const rows = results.map(({ source, status, outcome }) => {
    // 'restricted' means the host answered but refuses automation. That still
    // identifies a real, citable authority, so it stays approved and the
    // observed status is recorded in the notes.
    const approved = outcome === "ok" || outcome === "restricted";

    const provenance =
      outcome === "ok"
        ? `Reachability confirmed (HTTP ${status}).`
        : outcome === "restricted"
          ? `Host reachable but blocks automated checks (HTTP ${status}).`
          : `Not approved: reachability check returned ${outcome}${
              status ? ` (HTTP ${status})` : ""
            }.`;

    return {
      source_name: source.sourceName,
      source_url: source.sourceUrl,
      source_type: source.sourceType,
      approved,
      notes: `${source.notes} [${provenance} Checked ${new Date().toISOString()}]`,
      updated_at: new Date().toISOString(),
    };
  });

  const { data, error } = await db
    .from("content_sources")
    .upsert(rows, { onConflict: "source_url" })
    .select("source_name,source_url,approved");

  if (error) {
    console.error("source_sync_failed:", error.message);

    return NextResponse.json(
      { error: "Could not sync content sources", code: "server_error" },
      { status: 500 },
    );
  }

  await db.from("activity_log").insert({
    action: "sources_synced",
    entity_type: "content_sources",
    details: {
      total: rows.length,
      approved: rows.filter((row) => row.approved).length,
      outcomes: results.map(({ source, outcome, status }) => ({
        url: source.sourceUrl,
        outcome,
        status,
      })),
    },
  });

  return NextResponse.json({
    synced: rows.length,
    approved: rows.filter((row) => row.approved).length,
    rejected: results
      .filter(({ outcome }) => outcome !== "ok" && outcome !== "restricted")
      .map(({ source, outcome, status }) => ({
        url: source.sourceUrl,
        outcome,
        status,
      })),
    data,
  });
}
