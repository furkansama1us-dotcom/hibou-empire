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
  error text,
  publish_instagram boolean not null default true,
  publish_tiktok boolean not null default true,
  is_manual boolean not null default false
);
alter table public.pending_posts add column if not exists publish_instagram boolean not null default true;
alter table public.pending_posts add column if not exists publish_tiktok boolean not null default true;
alter table public.pending_posts add column if not exists is_manual boolean not null default false;
-- La génération manuelle instantanée cree la ligne AVANT que l'admin ait choisi
-- l'heure de publication (il la choisit devant l'apercu, a l'approbation).
alter table public.pending_posts alter column scheduled_for drop not null;
-- Le modele ne dessine plus le texte : il produit une scene nue en 9:16, et
-- l'application incruste le texte au canvas (typo identique d'une slide a
-- l'autre, ce qu'aucun modele d'image ne garantit). D'ou trois jeux d'images :
--   raw_images      : sorties Higgsfield brutes, sans texte
--   carousel_images : recadrage 4:5 avec texte -> ce qui part sur Instagram
--   video_images    : 9:16 integral avec texte -> pour le montage video
alter table public.pending_posts add column if not exists raw_images jsonb;
alter table public.pending_posts add column if not exists video_images jsonb;
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

-- ============================================================
-- Pivot "Nova" (mascotte avion en papier, 150 publications pré-écrites sur
-- 50 jours x 3 créneaux, générées par une routine Claude Code planifiée
-- (toutes les heures) via le Reference Element Higgsfield -- voir
-- api/ingest.js). Curseur : le prochain index (1-150) du calendrier plat
-- (data/nova-calendar.json) à générer. Accès service_role uniquement pour
-- la table de progression, aucune policy client nécessaire.
-- ============================================================

create table if not exists public.nova_progress (
  id int primary key default 1,
  next_index int not null default 1,
  start_date date
);
alter table public.nova_progress enable row level security;
insert into public.nova_progress (id, next_index) values (1, 1) on conflict (id) do nothing;
-- Migration depuis l'ancien schéma (next_jour, cycle 1-50) si déjà en place :
alter table public.nova_progress add column if not exists next_index int not null default 1;
-- start_date = date de publication du jour 1 du calendrier ; api/ingest.js en
-- déduit la date cible de chaque index (jour = ceil(index/3)).
alter table public.nova_progress add column if not exists start_date date;
update public.nova_progress set start_date = current_date where id = 1 and start_date is null;

-- ============================================================
-- Secrets applicatifs (jeton de rafraichissement Higgsfield, verifieurs PKCE
-- ephemeres). Aucune policy : seul le service_role y accede, jamais le client.
-- ============================================================

create table if not exists public.nova_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.nova_secrets enable row level security;

-- ============================================================
-- Demandes de génération manuelle (bouton "Générer" dans l'appli, en dehors
-- des 150 publications planifiées) : l'admin choisit un format (A-G), un
-- thème optionnel, l'heure/date de publication et les plateformes visées.
-- La routine planifiée (toutes les heures) traite les demandes "pending" en
-- plus des publications planifiées dues, dans la limite de quelques-unes
-- par passage pour ne pas surcharger une seule exécution.
-- ============================================================

create table if not exists public.nova_manual_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  format text not null, -- 'A' à 'G'
  custom_theme text, -- si vide, la routine pioche un thème de ce format pas encore utilisé
  scheduled_for date,
  scheduled_time text,
  publish_instagram boolean not null default true,
  publish_tiktok boolean not null default true,
  status text not null default 'pending', -- pending | done | failed
  pending_post_id uuid references public.pending_posts(id),
  error text
);
-- L'heure et les plateformes ne sont plus choisies au moment de la demande :
-- l'admin les fixe devant l'apercu, une fois le carrousel genere.
alter table public.nova_manual_requests alter column scheduled_for drop not null;
alter table public.nova_manual_requests alter column scheduled_time drop not null;
alter table public.nova_manual_requests enable row level security;

drop policy if exists "Admins can manage manual requests" on public.nova_manual_requests;
create policy "Admins can manage manual requests"
  on public.nova_manual_requests for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
