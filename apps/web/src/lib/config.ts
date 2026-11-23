/** Where the FastAPI server lives. Set NEXT_PUBLIC_API_URL to change it. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

export function wsUrlFor(docId: string): string {
  const base = API_URL.replace(/^http/, "ws"); // http -> ws, https -> wss
  return `${base}/ws/${docId}`;
}
