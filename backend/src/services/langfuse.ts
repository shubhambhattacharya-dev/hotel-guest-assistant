import { Langfuse } from "langfuse";

let langfuse: Langfuse | null = null;

export function initializeLangfuse(): void {
  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
      flushInterval: 5_000,
    });

    langfuse.on("error", (error) => {
      console.error("Langfuse error:", error);
    });
  }
}

export function getLangfuse(): Langfuse | null {
  return langfuse;
}

export { langfuse };