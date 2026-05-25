-- 1. Per-user ElevenLabs agent id cache
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS voice_agent_id text;

-- 2. Voice sessions history
CREATE TABLE IF NOT EXISTS public.voice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  turn_count integer NOT NULL DEFAULT 0,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.voice_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_sessions_select_own"
  ON public.voice_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "voice_sessions_insert_own"
  ON public.voice_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "voice_sessions_update_own"
  ON public.voice_sessions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "voice_sessions_delete_own"
  ON public.voice_sessions FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER voice_sessions_set_updated_at
  BEFORE UPDATE ON public.voice_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS voice_sessions_user_started_idx
  ON public.voice_sessions (user_id, started_at DESC);