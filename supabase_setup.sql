-- Hibou Empire — schéma Supabase (idempotent, relançable sans risque).
-- Dashboard Supabase > SQL Editor > New query > colle tout > Run

-- ============================================================
-- Admin unique (pas de comptes utilisateurs publics sur cette appli --
-- un seul admin qui pilote la génération/publication de contenu).
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- ============================================================
-- Contenu généré (carrousels), en attente d'approbation puis publiés
-- automatiquement (Instagram + TikTok, même contenu, même heure) une fois
-- approuvés et l'heure planifiée atteinte -- même logique que Score Master.
-- ============================================================

create table if not exists public.pending_posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  scheduled_for date not null,
  scheduled_time text,
  caption text not null,
  status text not null default 'generating', -- generating | pending | approved | published | failed | rejected
  carousel_images jsonb, -- tableau des URLs des slides composées, dans l'ordre
  hf_status_urls jsonb, -- statut Higgsfield par slide, pendant la génération
  overlay_data jsonb, -- {slides:[{kicker,headline,scene}], narrativeTitle}
  reviewed_at timestamptz,
  published_at timestamptz,
  error text
);
alter table public.pending_posts enable row level security;

drop policy if exists "Admins can manage pending posts" on public.pending_posts;
create policy "Admins can manage pending posts"
  on public.pending_posts for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Bucket public pour héberger les slides composées (fond Higgsfield + texte réel
-- habillé côté client, comme pour Score Master).
insert into storage.buckets (id, name, public)
values ('hibou-content', 'hibou-content', true)
on conflict (id) do nothing;

drop policy if exists "Public read hibou-content" on storage.objects;
create policy "Public read hibou-content"
  on storage.objects for select
  using (bucket_id = 'hibou-content');
