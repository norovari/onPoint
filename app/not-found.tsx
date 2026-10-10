import Link from "next/link";
export default function NotFound() {
  return (
    <main className="wrap" style={{ paddingTop: 48 }}>
      <h1>Not found</h1>
      <p className="lede">This page doesn’t exist, or your account doesn’t have access to it.</p>
      <Link href="/today" className="button">Go to Today</Link>
    </main>
  );
}
