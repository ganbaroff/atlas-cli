-- Sprint 1 — optional future table for learning decision audit mirror.
-- NOT APPLIED by default. CEO-gated like llm_spend.
-- Atlas source of truth for decisions remains local evidence ledger + exec-graph.
-- VOLAURA owns learner mastery; this table is a read replica / analytics sink only.

create table if not exists public.learning_decisions (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null unique,
  learner_id text not null,
  concept text not null,
  mastery_snapshot numeric(4,3) not null check (mastery_snapshot >= 0 and mastery_snapshot <= 1),
  action text not null,
  difficulty text not null,
  reason text not null,
  decision_score numeric(4,3) not null check (decision_score >= 0 and decision_score <= 1),
  alternatives jsonb not null default '[]'::jsonb,
  requires_human_review boolean not null default false,
  goal_id text,
  evidence_claim_id text,
  spend_correlation_id text,
  issued_by text not null default 'volaura',
  created_at timestamptz not null default now()
);

create index if not exists learning_decisions_learner_idx
  on public.learning_decisions (learner_id, created_at desc);

create index if not exists learning_decisions_concept_idx
  on public.learning_decisions (concept, created_at desc);

-- Outcome feedback (separate from mastery — Atlas audit only)
create table if not exists public.learning_outcomes (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null unique,
  decision_correlation_id text not null references public.learning_decisions (correlation_id),
  learner_id text not null,
  concept text not null,
  completed boolean not null,
  correct boolean not null,
  response_time_sec numeric(8,2) not null,
  self_reported_confidence numeric(4,3),
  evidence_claim_id text,
  created_at timestamptz not null default now()
);

create index if not exists learning_outcomes_decision_idx
  on public.learning_outcomes (decision_correlation_id);
