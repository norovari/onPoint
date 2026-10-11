import "server-only";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { supabaseEnv } from "@/lib/supabase/env";

// End-of-shift statements: password check, private photo storage, and the
// short text that goes into the owner's email.

export const BUCKET = "shift-photos";
export const MAX_PHOTOS = 4;
const MAX_BYTES = 3 * 1024 * 1024;

export const QUESTIONS = {
  unrung: "Did anything leave the shop tonight that wasn’t rung up (samples, extras, freebies)?",
  stock_event: "Did anything happen to stock: spills, breakages, returns?",
  notes: "Anything the owner should know about tonight?",
} as const;

// The person's own password stands in for a signature. Checked with a
// throwaway client so the browser session is untouched.
export async function passwordMatches(email: string, password: string) {
  const { url, key } = supabaseEnv();
  const temp = createPlainClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await temp.auth.signInWithPassword({ email, password });
  if (error) return false;
  await temp.auth.signOut({ scope: "local" });
  return true;
}

export function checkPhotos(files: File[]) {
  if (files.length === 0) return "Take at least one photo: the jar on the scale, or the cash drawer.";
  if (files.length > MAX_PHOTOS) return `Up to ${MAX_PHOTOS} photos.`;
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return "Photos must be pictures (JPEG or PNG).";
    if (f.size > MAX_BYTES) return "One of the photos is too large. Take it again.";
  }
  return null;
}

export async function storePhotos(prefix: string, files: File[]) {
  const svc = createServiceClient();
  const { error: getErr } = await svc.storage.getBucket(BUCKET);
  if (getErr) await svc.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
  const paths: string[] = [];
  for (const [i, f] of files.entries()) {
    const ext = f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
    const path = `${prefix}/${Date.now()}-${i}.${ext}`;
    const { error } = await svc.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false });
    if (error) throw new Error("Photo upload failed");
    paths.push(path);
  }
  return paths;
}

// Short-lived links so photos never sit on a public URL
export async function photoLinks(paths: string[]) {
  if (paths.length === 0) return new Map<string, string>();
  const svc = createServiceClient();
  const { data } = await svc.storage.from(BUCKET).createSignedUrls(paths, 60 * 60);
  return new Map<string, string>((data ?? []).filter((d) => d.signedUrl && d.path).map((d) => [d.path as string, d.signedUrl as string]));
}

export type StatementRow = {
  user_id: string; unrung: boolean; unrung_detail: string | null; stock_event: boolean; stock_event_detail: string | null;
  notes: string | null; photos: string[]; created_at: string; name?: string;
};

export function statementText(s: StatementRow) {
  return [
    `${s.name ?? "Team member"}:`,
    `  Anything not rung up? ${s.unrung ? `Yes: ${s.unrung_detail}` : "No"}`,
    `  Anything happen to stock? ${s.stock_event ? `Yes: ${s.stock_event_detail}` : "No"}`,
    s.notes ? `  Notes: ${s.notes}` : "",
    `  ${s.photos.length} photo${s.photos.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join("\n");
}
