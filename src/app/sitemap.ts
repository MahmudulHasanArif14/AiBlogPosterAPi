import type { MetadataRoute } from "next";
import { supabaseAdmin } from "@/lib/supabase";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> { const base=(process.env.SITE_URL||"https://content.westerncars.co.uk").replace(/\/$/,""); const db=supabaseAdmin(); const {data}=await db.from("posts").select("slug,published_at").eq("status","published"); return [{url:base,lastModified:new Date()},...(data||[]).map(p=>({url:`${base}/posts/${p.slug}`,lastModified:p.published_at?new Date(p.published_at):new Date()}))]; }
