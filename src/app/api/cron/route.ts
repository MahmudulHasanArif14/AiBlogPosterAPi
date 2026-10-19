import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { WEEKLY_TOPICS } from "@/lib/topics";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  const secret=process.env.CRON_SECRET; if(!secret||req.headers.get("authorization")!==`Bearer ${secret}`) return NextResponse.json({error:"Unauthorized"},{status:401});
  const db=supabaseAdmin(); const now=new Date(); const weekday=now.getUTCDay();
  // Hobby cron runs daily. Only create a scheduled article on weekdays; the worker handles one job per run.
  if(weekday===0||weekday===6) return NextResponse.json({ok:true,message:"Weekend; no scheduled article"});
  const topic=WEEKLY_TOPICS.find(x=>x.day===weekday); if(!topic) return NextResponse.json({ok:true,message:"No topic configured for today"});
  const dayStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();
  const dayEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)).toISOString();
  const {data:existing}=await db.from("generation_jobs").select("id,status").gte("scheduled_for",dayStart).lt("scheduled_for",dayEnd).eq("topic",topic.topic).limit(1);
  if(existing?.length) return NextResponse.json({ok:true,message:"Job already scheduled today",jobId:existing[0].id});
  const {data:loc}=await db.from("locations").select("id,enabled").eq("slug",topic.location).single();
  if(!loc?.enabled) return NextResponse.json({ok:true,message:"Location disabled; skipping"});
  const {data:job,error}=await db.from("generation_jobs").insert({location_id:loc.id,topic:topic.topic,status:"queued",scheduled_for:now.toISOString()}).select("id").single();
  if(error||!job) return NextResponse.json({error:"Could not queue job"},{status:500});
  // Internal loopback call uses the same protected endpoint; deployment URL must be configured.
  const base=(process.env.SITE_URL||"").replace(/\/$/,""); if(!base) return NextResponse.json({error:"SITE_URL missing; job queued for later processing",jobId:job.id},{status:500});
  const response=await fetch(`${base}/api/generate`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({locationSlug:topic.location,topic:topic.topic,jobId:job.id}),signal:AbortSignal.timeout(95000)}).catch(()=>null);
  if(!response||!response.ok){await db.from("generation_jobs").update({status:"failed",attempts:1,error_message:"generation_failed_retry_required"}).eq("id",job.id); return NextResponse.json({ok:false,jobId:job.id,message:"Generation failed; job recorded for retry"},{status:502});}
  return NextResponse.json({ok:true,jobId:job.id,result:await response.json().catch(()=>({}))});
}
