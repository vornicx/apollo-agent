# Apollo Launch Stack

## Decision

Apollo launches without Lovable.

The launch stack is:

- Frontend/runtime: TanStack Start, React, TypeScript, Tailwind
- Hosting: Cloudflare Workers/Pages
- Database: Supabase Postgres
- Auth: Supabase Auth
- Memory MVP: Supabase tables, then pgvector
- AI runtime: direct provider APIs
- User keys: BYOK stored in Supabase `api_keys`
- Server fallback keys: Cloudflare environment secrets
- Voice: ElevenLabs
- Later queue: Upstash Redis
- Later vector database: Qdrant

## Provider Strategy

Apollo calls providers directly:

- OpenAI-compatible APIs: OpenAI, Groq, Mistral, OpenRouter
- Anthropic Messages API
- Google Gemini API

Mission execution resolves keys in this order:

1. User BYOK key from `api_keys`
2. Server fallback key from environment variables
3. Clear error asking the user to add a key

This avoids vendor lock-in and lets Apollo run on user-owned infrastructure.

## Required Launch Secrets

Supabase:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

AI providers:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_AI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `OPENROUTER_API_KEY`

Apollo defaults:

- `APOLLO_EXTRACT_PROVIDER=openrouter`
- `APOLLO_EXTRACT_MODEL=openrouter/owl-alpha`

Voice:

- `ELEVENLABS_API_KEY`

## Free-Tier Path

Start with:

- Supabase Free for Postgres/Auth/RLS
- Cloudflare free/low-cost hosting
- User BYOK for AI costs
- Server OpenAI key only as a controlled fallback

Add only when needed:

- pgvector when semantic memory ships
- Upstash Redis when background queues/rate limits ship
- Qdrant when vector memory outgrows Postgres

## Launch Checklist

- Remove all Lovable packages and imports.
- Use Supabase OAuth directly.
- Apply all Supabase migrations.
- Configure Supabase auth redirect URLs.
- Configure Cloudflare secrets.
- Add at least one provider key through `/keys` or server env.
- Run `npm run build`.
- Test mission streaming: Planner -> Implementer -> Reviewer.
