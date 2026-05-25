import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: "Privacy Policy — AI Hub" },
      { name: "description", content: "How AI Hub collects, stores and protects your data and API keys." },
      { property: "og:title", content: "Privacy Policy — AI Hub" },
      { property: "og:url", content: "/privacy" },
    ],
    links: [{ rel: "canonical", href: "/privacy" }],
  }),
});

function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
      <h1 className="mt-6 text-3xl font-semibold">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: May 25, 2026</p>

      <section className="prose prose-invert mt-8 max-w-none text-sm leading-relaxed text-foreground/90">
        <h2 className="mt-8 text-lg font-semibold">1. Data we collect</h2>
        <p>
          When you sign up we store your email, an authenticated user ID and any profile
          information you choose to provide (display name). When you add API keys for
          third-party AI providers, we store them encrypted at rest. We also store the
          chat conversations and messages you create inside the app.
        </p>

        <h2 className="mt-8 text-lg font-semibold">2. How your API keys are used</h2>
        <p>
          Your provider API keys (Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter)
          are used exclusively to forward your chat requests to the corresponding
          provider on your behalf. We never share them with third parties, never use
          them for our own purposes and never expose them back to your browser — only a
          masked preview is shown in the UI.
        </p>

        <h2 className="mt-8 text-lg font-semibold">3. Third-party AI providers</h2>
        <p>
          When you send a message, its content and your conversation history are
          transmitted to the AI provider you selected. Those providers process your
          data under their own privacy policies — please review them before sending
          sensitive information.
        </p>

        <h2 className="mt-8 text-lg font-semibold">4. Storage and security</h2>
        <p>
          All traffic is encrypted in transit using HTTPS/TLS. Data is stored in a
          managed Postgres database with row-level security: each row is readable only
          by its owner. We use industry-standard authentication (email/password or
          Google OAuth).
        </p>

        <h2 className="mt-8 text-lg font-semibold">5. Your rights</h2>
        <p>
          You can delete any API key, conversation or your entire account at any time
          from within the app. On account deletion, all associated data is removed.
          You may also request access, rectification or portability of your data by
          contacting us.
        </p>

        <h2 className="mt-8 text-lg font-semibold">6. Cookies</h2>
        <p>
          We use strictly necessary cookies and local storage to keep you signed in.
          We do not use advertising or third-party tracking cookies. See our{" "}
          <Link to="/cookies" className="text-primary underline">Cookie Policy</Link>.
        </p>

        <h2 className="mt-8 text-lg font-semibold">7. Contact</h2>
        <p>For any privacy-related question, contact the project owner.</p>
      </section>
    </main>
  );
}
