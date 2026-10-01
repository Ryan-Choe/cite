// Placeholder until the chat UI is built (see docs/DESIGN.md, build order step 4).
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Cite</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Answers from the PostHog handbook (snapshot of Apr 20, 2026), with page
        citations.
      </p>
      <a
        href="/handbook.pdf#page=980"
        target="_blank"
        rel="noreferrer"
        className="mt-6 text-sm underline underline-offset-4"
      >
        Open the handbook at p. 980 ↗
      </a>
    </main>
  );
}
