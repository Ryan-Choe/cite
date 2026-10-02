import { connection } from "next/server";
import { hasApiKey } from "@/lib/answer/claude";
import { Chat } from "./chat";

export default async function Home() {
  await connection(); // check the API key per request, not once at build time
  return <Chat apiKeyConfigured={hasApiKey()} />;
}
