import { NextResponse } from "next/server";
import { checkEmails, ensureSchema } from "@/lib/db";

export async function POST(req: Request) {
  try {
    await ensureSchema();
  } catch (e) {
    return NextResponse.json(
      { error: "Database not connected. Add Neon Postgres in the Vercel dashboard." },
      { status: 500 }
    );
  }
  let body: { emails?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const emails = Array.isArray(body.emails)
    ? body.emails.filter((e): e is string => typeof e === "string").slice(0, 50000)
    : [];
  if (emails.length === 0) {
    return NextResponse.json({ existing: [] });
  }
  try {
    const existing = await checkEmails(emails);
    return NextResponse.json({ existing });
  } catch (e) {
    console.error("check failed", e);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
