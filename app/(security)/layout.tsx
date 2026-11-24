import Link from "next/link";

export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <Link href="/" className="mb-8 flex items-center gap-2.5 text-lg font-semibold no-underline" aria-label="AI Twin home">
        <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-zinc-900 text-sm text-white">ai</span>
        AI Twin
      </Link>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        {children}
      </div>
    </main>
  );
}
