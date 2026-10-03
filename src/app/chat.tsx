"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_HISTORY, MAX_QUESTION_CHARS, type AskResponse, type AskResult, type Citation } from "@/lib/answer/types";
import { isUncitedClaim } from "@/lib/answer/uncited";

const EXAMPLE_QUESTIONS = [
  "How much time off should I take each year?",
  "Can I expense a new laptop?",
  "How do I raise a grievance?",
  "What is a small team at PostHog?",
];

interface Exchange {
  id: number;
  question: string;
  response: AskResponse | "pending";
}

export function Chat({ apiKeyConfigured }: { apiKeyConfigured: boolean }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = exchanges.some((e) => e.response === "pending");

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [exchanges]);

  async function ask(question: string, replaceId?: number) {
    const id = replaceId ?? nextId.current++;
    const earlier = exchanges.filter((e) => e.id !== id && isResult(e.response)).slice(-MAX_HISTORY);
    const history = earlier.map((e) => ({ question: e.question, searchedFor: (e.response as AskResult).searchedFor }));

    setExchanges((list) =>
      replaceId ? list.map((e) => (e.id === id ? { ...e, response: "pending" } : e)) : [...list, { id, question, response: "pending" }],
    );
    const response = await postQuestion(question, history);
    setExchanges((list) => list.map((e) => (e.id === id ? { ...e, response } : e)));
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    void ask(question);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-200 py-5 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cite</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Answers from the PostHog handbook (snapshot of Apr 20, 2026), with the pages they came from.
          </p>
        </div>
        {exchanges.length > 0 && (
          <button
            type="button"
            onClick={() => setExchanges([])}
            disabled={busy}
            className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            New conversation
          </button>
        )}
      </header>

      {!apiKeyConfigured && (
        <div role="alert" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <strong>Setup needed:</strong> add your Anthropic API key to <code>.env.local</code> as{" "}
          <code>ANTHROPIC_API_KEY=…</code> (see <code>.env.example</code>), then restart <code>npm run dev</code>.
        </div>
      )}

      <main className="flex-1 py-6" aria-live="polite">
        {exchanges.length === 0 ? (
          <EmptyState onPick={(q) => void ask(q)} disabled={busy} />
        ) : (
          <ol className="space-y-8">
            {exchanges.map((exchange) => (
              <li key={exchange.id} className="space-y-3">
                <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2 dark:bg-zinc-800">{exchange.question}</p>
                <Reply exchange={exchange} onRetry={() => void ask(exchange.question, exchange.id)} />
              </li>
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </main>

      <form onSubmit={submit} className="sticky bottom-0 border-t border-zinc-200 bg-background py-4 dark:border-zinc-800">
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="question"
            rows={2}
            value={draft}
            maxLength={MAX_QUESTION_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about the handbook…"
            className="flex-1 resize-none rounded-md border border-zinc-300 bg-transparent px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Ask
          </button>
        </div>
        <p className="mt-1.5 flex justify-between text-xs text-zinc-500">
          <span>Answers come only from the handbook. Enter to send, Shift+Enter for a new line.</span>
          {draft.length > MAX_QUESTION_CHARS - 100 && (
            <span>
              {draft.length}/{MAX_QUESTION_CHARS}
            </span>
          )}
        </p>
      </form>
    </div>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (question: string) => void; disabled: boolean }) {
  return (
    <div className="pt-8">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Try one of these:</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {EXAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            className="rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function Reply({ exchange, onRetry }: { exchange: Exchange; onRetry: () => void }) {
  const { response } = exchange;

  if (response === "pending") {
    return <p className="animate-pulse text-sm text-zinc-500">Searching the handbook and writing an answer…</p>;
  }

  if (response.status === "error") {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
        <p>{response.message}</p>
        {response.retryable && (
          <button type="button" onClick={onRetry} className="mt-2 underline underline-offset-4">
            Retry
          </button>
        )}
      </div>
    );
  }

  const searchedFor =
    response.searchedFor !== exchange.question ? (
      <p className="text-xs text-zinc-500">
        Searched for: <em>{response.searchedFor}</em>
      </p>
    ) : null;

  if (response.status === "not-covered") {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="font-medium">Not found in the passages searched</p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Search didn&apos;t find a passage that answers this, so I won&apos;t guess. The handbook may still cover it; these
            sections looked closest:
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {response.closest.map((section) => (
              <li key={section.title}>
                <PageLink page={section.page}>{section.title}</PageLink>
              </li>
            ))}
          </ul>
        </div>
        {searchedFor}
      </div>
    );
  }

  const cardId = (n: number) => `cite-${exchange.id}-${n}`;
  const hasUncited = response.parts.some(isUncitedClaim);
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-wrap leading-relaxed">
        {response.parts.map((part, i) => {
          // Put markers right after the cited words, before any trailing line break.
          const text = part.text.trimEnd();
          const trailing = part.text.slice(text.length);
          return (
            <span key={i}>
              {isUncitedClaim(part) ? (
                <span
                  title="Not backed by a citation"
                  className="text-zinc-500 underline decoration-zinc-400 decoration-dotted underline-offset-4 dark:text-zinc-400 dark:decoration-zinc-500"
                >
                  {text}
                  <span className="sr-only"> (not cited)</span>
                </span>
              ) : (
                text
              )}
              {part.citations.map((n) => (
                <a
                  key={n}
                  href={`#${cardId(n)}`}
                  onClick={() => openCard(cardId(n))}
                  className="ml-0.5 align-super text-xs font-medium text-blue-700 no-underline hover:underline dark:text-blue-400"
                >
                  [{n}]
                </a>
              ))}
              {trailing}
            </span>
          );
        })}
      </p>
      {hasUncited && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Grey, dotted text isn&apos;t backed by a citation; check it against the handbook.</p>
      )}
      {response.gaps.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Not found in the passages searched</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {response.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
          <p className="mt-2">
            Search only reads part of the handbook, so it may still cover this. To be sure, search the{" "}
            <PageLink page={1}>handbook PDF</PageLink>.
          </p>
        </div>
      )}
      <ol className="space-y-1.5">
        {response.citations.map((c, i) => (
          <CitationCard
            key={c.n}
            id={cardId(c.n)}
            citation={c}
            showTitle={i === 0 || response.citations[i - 1].title !== c.title}
          />
        ))}
      </ol>
      {searchedFor}
    </div>
  );
}

/** A citation: the section title (only when it changes from the card above), then a one-line quote preview that expands to the full quote. */
function CitationCard({ id, citation, showTitle }: { id: string; citation: Citation; showTitle: boolean }) {
  const pages = citation.pages.length > 1 ? `pp. ${citation.pages.join("–")}` : `p. ${citation.pages[0]}`;
  return (
    <li>
      {showTitle && <p className="mb-1 mt-3 text-xs font-medium text-zinc-500">{citation.title}</p>}
      <details id={id} className="group rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
        <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-2">
          <span className="font-medium text-blue-700 dark:text-blue-400">[{citation.n}]</span>
          <span className="flex-1 truncate text-zinc-700 group-open:invisible dark:text-zinc-300">
            {citation.quote.replace(/^\s*- /, "")}
          </span>
          <PageLink page={citation.pages[0]}>{pages}</PageLink>
        </summary>
        <blockquote className="whitespace-pre-wrap border-t border-zinc-200 px-3 py-2 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
          {citation.quote}
        </blockquote>
      </details>
    </li>
  );
}

function PageLink({ page, children }: { page: number; children: React.ReactNode }) {
  return (
    <a
      href={`/handbook.pdf#page=${page}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()} // don't toggle the surrounding <details>
      className="whitespace-nowrap underline underline-offset-4"
    >
      {children} ↗
    </a>
  );
}

function openCard(id: string) {
  const card = document.getElementById(id);
  if (card instanceof HTMLDetailsElement) card.open = true;
}

function isResult(response: AskResponse | "pending"): response is AskResult {
  return response !== "pending" && response.status !== "error";
}

async function postQuestion(question: string, history: { question: string; searchedFor: string }[]): Promise<AskResponse> {
  let res: Response;
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
    });
  } catch {
    return { status: "error", code: "unavailable", message: "Couldn't reach the Cite server. Is `npm run dev` running?", retryable: true };
  }
  // The server answered; if it isn't an AskResponse, it crashed before it could build one.
  const body: unknown = await res.json().catch(() => null);
  if (isAskResponse(body)) return body;
  return {
    status: "error",
    code: "unavailable",
    message: `The Cite server hit an error (HTTP ${res.status}). The details are in the terminal running it.`,
    retryable: true,
  };
}

function isAskResponse(body: unknown): body is AskResponse {
  if (typeof body !== "object" || body === null) return false;
  const response = body as Partial<Record<string, unknown>>;
  switch (response.status) {
    case "answered":
      return Array.isArray(response.parts) && Array.isArray(response.citations) && Array.isArray(response.gaps);
    case "not-covered":
      return Array.isArray(response.closest);
    case "error":
      return typeof response.message === "string";
    default:
      return false;
  }
}
