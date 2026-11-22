"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-5 text-center">
      <h1 className="text-xl font-semibold">Unable to load your workspace</h1>
      <p className="text-zinc-500">Please try again in a moment.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
