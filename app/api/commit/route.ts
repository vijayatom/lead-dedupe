import { NextResponse } from "next/server";
import { commitEmails, ensureSchema } from "@/lib/db";

export async function POST(req: Request) {
  try {
    await ensureSchema();
  } catch {
    return NextResponse.json(
      { error: "Database not connected. Add Neon Postgres in the Vercel dashboard." },
      { status: 500 }
    );
  }
  let body: {
    emails?: unknown;
    campaign?: unknown;
    totalRows?: unknown;
    dupCount?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const entries = Array.isArray(body.emails)
    ? (body.emails as unknown[])
        .filter((e): e is { email: string; campaign?: unknown } =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { email?: unknown }).email === "string"
        )
        .map((e) => ({
          email: e.email.toLowerCase(),
          campaign:
            typeof e.campaign === "string" && e.campaign.length > 0
              ? e.campaign.slice(0, 200)
              : "upload",
        }))
        .slice(0, 50000)
    : [];
  const campaign =
    typeof body.campaign === "string" && body.campaign.length > 0
      ? body.campaign.slice(0, 200)
      : "upload";
  const totalRows = typeof body.totalRows === "number" ? body.totalRows : entries.length;
  const dupCount = typeof body.dupCount === "number" ? body.dupCount : 0;
  try {
    const { inserted } = await commitEmails(entries, campaign, totalRows, dupCount);
    return NextResponse.json({ inserted });
  } catch (e) {
    console.error("commit failed", e);
    return NextResponse.json({ error: "Save failed." }, { status: 500 });
  }
}
