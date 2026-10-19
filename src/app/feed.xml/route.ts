import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { htmlEscape } from "@/lib/article";
export async function GET(req: NextRequest) {
 const location=req.nextUrl.searchParams.get("location"); const db=supabaseAdmin(); let q=db.from("posts").select("title,slug,excerpt,canonical_url,published_at,location_id").eq("status","published").order("published_at",{ascending:false}).limit(50);
 if(location){const {data:loc}=await db.from("locations").select("id").eq("slug",location).eq("enabled",true).single();if(!loc)return new Response("Unknown location",{status:404});q=q.eq("location_id",loc.id);}
 const {data}=await q; const base=(process.env.SITE_URL||"https://content.westerncars.co.uk").replace(/\/$/,""); const items=(data||[]).map(p=>`<item><title>${htmlEscape(p.title)}</title><link>${htmlEscape(p.canonical_url||`${base}/posts/${p.slug}`)}</link><guid isPermaLink="true">${htmlEscape(p.canonical_url||`${base}/posts/${p.slug}`)}</guid><pubDate>${new Date(p.published_at||Date.now()).toUTCString()}</pubDate><description>${htmlEscape(p.excerpt)}</description></item>`).join("");
 const xml=`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Western Cars ${location||"Travel"} Articles</title><link>${htmlEscape(base)}</link><description>Published Western Cars travel articles</description>${items}</channel></rss>`; return new Response(xml,{headers:{"Content-Type":"application/rss+xml; charset=utf-8","Cache-Control":"public, s-maxage=300"}});
}
