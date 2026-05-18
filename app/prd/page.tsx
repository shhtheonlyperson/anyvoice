import Link from "next/link";

export default function PrdPage() {
  return (
    <main className="doc-page">
      <Link href="/" className="doc-back">
        AnyVoice
      </Link>
      <h1>AnyVoice PRD</h1>
      <p>
        Build a consent-gated VoxCPM2 voice cloning studio that runs the product
        workflow on Vercel and sends real inference to a local or GPU worker.
      </p>
      <section>
        <h2>Acceptance Criteria</h2>
        <ul>
          <li>Record or upload a voice reference.</li>
          <li>Enter target text and optional style guidance.</li>
          <li>Use an optional exact transcript for ultimate cloning.</li>
          <li>Require permission confirmation before submission.</li>
          <li>Return playable audio when the VoxCPM2 worker is connected.</li>
          <li>Show a clear worker-missing state on Vercel preview.</li>
        </ul>
      </section>
    </main>
  );
}
