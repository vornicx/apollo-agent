
CREATE TABLE public.memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  content text NOT NULL,
  kind text NOT NULL DEFAULT 'note',
  source text,
  importance int NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

CREATE INDEX memories_user_created_idx ON public.memories(user_id, created_at DESC);
CREATE INDEX memories_tsv_idx ON public.memories USING GIN(content_tsv);
CREATE INDEX memories_source_idx ON public.memories(user_id, source);

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY memories_select_own ON public.memories FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY memories_insert_own ON public.memories FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY memories_update_own ON public.memories FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY memories_delete_own ON public.memories FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER memories_set_updated_at
BEFORE UPDATE ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
