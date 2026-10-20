import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runGenerationJob } from "@/lib/generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby plan ceiling. The provider call is bounded well inside this so the
// database still gets its completion write.
export const maxDuration = 60;

const RequestSchema = z.object({
  locationSlug: z.string().min(2).max(80),
  topic: z.string().min(5).max(600),
  jobId: z.string().uuid(),
});

function cronAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Operator-triggered generation for one existing job. Protected by CRON_SECRET.
 * The scheduled path does not call this over HTTP; both share
 * `runGenerationJob` directly.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", code: "invalid_request" },
      { status: 400 },
    );
  }

  const outcome = await runGenerationJob(parsed.data);

  return NextResponse.json(outcome.body, { status: outcome.httpStatus });
}
