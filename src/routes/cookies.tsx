import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/cookies")({
  component: CookiesPage,
  head: () => ({
    meta: [
      { title: "Cookie Policy — AI Hub" },
      { name: "description", content: "How AI Hub uses cookies and local storage." },
      { property: "og:title", content: "Cookie Policy — AI Hub" },
      { property: "og:url", content: "/cookies" },
    ],
    links: [{ rel: "canonical", href: "/cookies" }],
  }),
});

function CookiesPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
      <h1 className="mt-6 text-3xl font-semibold">Cookie Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: May 25, 2026</p>

      <section className="prose prose-invert mt-8 max-w-none text-sm leading-relaxed text-foreground/90 space-y-4">
        <p>
          AI Hub uses only <strong>strictly necessary</strong> cookies and browser
          local storage. These are required for the app to function and do not need
          prior consent under the GDPR/ePrivacy directive.
        </p>

        <h2 className="mt-6 text-lg font-semibold">What we store</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Authentication tokens</strong> — stored in <code>localStorage</code> by
            our authentication provider to keep you signed in across page reloads.
          </li>
          <li>
            <strong>UI preferences</strong> — small values such as the cookie
            notice acknowledgment, kept locally in your browser.
          </li>
        </ul>

        <h2 className="mt-6 text-lg font-semibold">What we do NOT use</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>No advertising cookies.</li>
          <li>No third-party analytics or trackers.</li>
          <li>No cross-site tracking.</li>
        </ul>

        <p>
          You can clear cookies and local storage at any time from your browser
          settings — doing so will sign you out. See also our{" "}
          <Link to="/privacy" className="text-primary underline">Privacy Policy</Link>.
        </p>
      </section>
    </main>
  );
}
