import { NextResponse } from "next/server";
import { ensureSchema, getStats } from "@/lib/db";

export async function GET() {
  try {
    await ensureSchema();
    const stats = await getStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ dbConnected: false, totalEmails: 0, campaigns: [] });
  }
}
