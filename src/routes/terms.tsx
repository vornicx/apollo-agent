import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: "Terms of Service — AI Hub" },
      { name: "description", content: "Terms governing the use of AI Hub." },
      { property: "og:title", content: "Terms of Service — AI Hub" },
      { property: "og:url", content: "/terms" },
    ],
    links: [{ rel: "canonical", href: "/terms" }],
  }),
});

function TermsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
      <h1 className="mt-6 text-3xl font-semibold">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: May 25, 2026</p>

      <section className="prose prose-invert mt-8 max-w-none text-sm leading-relaxed text-foreground/90 space-y-4">
        <p>
          By using AI Hub you agree to use the service responsibly and in
          compliance with the terms of the AI providers whose API keys you connect.
          You are solely responsible for the API keys you upload, the costs they
          incur with the underlying providers and the content you send through them.
        </p>
        <p>
          The service is provided "as is" without warranties of any kind. We are not
          liable for outages, model errors, hallucinations, data loss or charges
          billed by third-party AI providers.
        </p>
        <p>
          We may suspend accounts that abuse the service, attempt to break security
          or violate provider terms.
        </p>
        <p>
          See also our{" "}
          <Link to="/privacy" className="text-primary underline">Privacy Policy</Link>{" "}
          and{" "}
          <Link to="/cookies" className="text-primary underline">Cookie Policy</Link>.
        </p>
      </section>
    </main>
  );
}
