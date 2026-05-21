// Runs once when the Next.js server starts. We use it to auto-resume any book
// whose background synthesis was mid-flight before a restart, so synthesis keeps
// running without the user having to revisit the page.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { resumeInProgressBooks } = await import("@/lib/book-synthesizer");
    await resumeInProgressBooks();
  } catch {
    /* best-effort: a failed resume must never block server startup */
  }
}
