import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import { ensureSchema, getStats } from "@/lib/db";

export async function GET() {
  try {
    await ensureSchema();
    const stats = await getStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ connected: false, totalEmails: 0, campaigns: [] });
  }
}
