-- Apollo Core Runtime MVP
-- Keeps the first production slice small: projects, mission runs, preferences,
-- costs, prompt versions and orchestration learning.

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS complexity numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS confidence numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  memory_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_user_updated_idx
  ON public.projects(user_id, updated_at DESC);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'projects_select_own') THEN
    CREATE POLICY projects_select_own ON public.projects FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'projects_insert_own') THEN
    CREATE POLICY projects_insert_own ON public.projects FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'projects_update_own') THEN
    CREATE POLICY projects_update_own ON public.projects FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'projects_delete_own') THEN
    CREATE POLICY projects_delete_own ON public.projects FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preference_type text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric NOT NULL DEFAULT 0,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, preference_type)
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences' AND policyname = 'user_preferences_select_own') THEN
    CREATE POLICY user_preferences_select_own ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences' AND policyname = 'user_preferences_insert_own') THEN
    CREATE POLICY user_preferences_insert_own ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences' AND policyname = 'user_preferences_update_own') THEN
    CREATE POLICY user_preferences_update_own ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences' AND policyname = 'user_preferences_delete_own') THEN
    CREATE POLICY user_preferences_delete_own ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TRIGGER user_preferences_set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.mission_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'created',
  complexity numeric NOT NULL DEFAULT 0,
  risk_level text NOT NULL DEFAULT 'low',
  route text NOT NULL DEFAULT 'manual',
  planner_model text,
  implementer_model text,
  reviewer_model text,
  latency numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0,
  review_score numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS mission_runs_mission_idx
  ON public.mission_runs(mission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mission_runs_user_idx
  ON public.mission_runs(user_id, created_at DESC);

ALTER TABLE public.mission_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mission_runs' AND policyname = 'mission_runs_select_own') THEN
    CREATE POLICY mission_runs_select_own ON public.mission_runs FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mission_runs' AND policyname = 'mission_runs_insert_own') THEN
    CREATE POLICY mission_runs_insert_own ON public.mission_runs FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mission_runs' AND policyname = 'mission_runs_update_own') THEN
    CREATE POLICY mission_runs_update_own ON public.mission_runs FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.mission_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  models_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens integer NOT NULL DEFAULT 0,
  latency numeric NOT NULL DEFAULT 0,
  estimated_cost numeric NOT NULL DEFAULT 0,
  actual_cost numeric NOT NULL DEFAULT 0,
  margin numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mission_costs_mission_idx
  ON public.mission_costs(mission_id, created_at DESC);

ALTER TABLE public.mission_costs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mission_costs' AND policyname = 'mission_costs_select_own') THEN
    CREATE POLICY mission_costs_select_own ON public.mission_costs FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mission_costs' AND policyname = 'mission_costs_insert_own') THEN
    CREATE POLICY mission_costs_insert_own ON public.mission_costs FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL,
  version text NOT NULL,
  prompt text NOT NULL,
  success_score numeric NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_type, version)
);

ALTER TABLE public.prompt_versions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prompt_versions' AND policyname = 'prompt_versions_read_all') THEN
    CREATE POLICY prompt_versions_read_all ON public.prompt_versions FOR SELECT USING (true);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.orchestration_learning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type text NOT NULL,
  complexity numeric NOT NULL DEFAULT 0,
  models_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  success_score numeric NOT NULL DEFAULT 0,
  latency numeric NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  review_score numeric,
  prompt_version text,
  strategy_used jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.orchestration_learning ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orchestration_learning' AND policyname = 'orchestration_learning_read_all') THEN
    CREATE POLICY orchestration_learning_read_all ON public.orchestration_learning FOR SELECT USING (true);
  END IF;
END $$;
