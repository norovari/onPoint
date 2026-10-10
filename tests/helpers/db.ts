// Runs the real Supabase migrations inside an in-process Postgres (PGlite),
// with a minimal stand-in for Supabase's auth schema and roles, so the
// security rules and workflow functions can be tested without a cloud project.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");

const AUTH_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

const GRANTS = `
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  grant usage, select on all sequences in schema public to anon, authenticated;
`;

export type Db = PGlite & {
  as: <T>(userId: string | null, fn: (q: PGlite) => Promise<T>) => Promise<T>;
};

export async function createDb(): Promise<Db> {
  const db = new PGlite() as Db;
  await db.exec(AUTH_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  await db.exec(GRANTS);

  // Run a block as a signed-in user (role authenticated + JWT sub), like PostgREST does.
  db.as = async (userId, fn) => {
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ""]);
      await tx.exec(userId ? "set local role authenticated" : "set local role anon");
      return fn(tx as unknown as PGlite);
    });
  };
  return db;
}

export async function createUser(db: PGlite, id: string, name: string) {
  await db.query(`insert into auth.users (id, raw_user_meta_data) values ($1, $2)`, [id, { full_name: name }]);
}
