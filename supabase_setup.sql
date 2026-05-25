-- PokeGrade — Supabase Schema Setup
-- À exécuter dans Supabase → SQL Editor

-- 1. Table profils utilisateurs
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  grades_this_month integer default 0,
  last_reset_date date default current_date,
  is_premium boolean default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamp with time zone default now()
);

-- 2. Table historique des grades
create table if not exists public.grades (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade,
  result jsonb,
  created_at timestamp with time zone default now()
);

-- 3. Activer Row Level Security
alter table public.profiles enable row level security;
alter table public.grades enable row level security;

-- 4. Politiques RLS — profiles
create policy "Voir son propre profil" on public.profiles
  for select using (auth.uid() = id);

create policy "Modifier son propre profil" on public.profiles
  for update using (auth.uid() = id);

-- 5. Politiques RLS — grades
create policy "Voir ses propres grades" on public.grades
  for select using (auth.uid() = user_id);

create policy "Insérer ses propres grades" on public.grades
  for insert with check (auth.uid() = user_id);

-- 6. Fonction : créer le profil automatiquement à l'inscription
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

-- 7. Trigger sur création de compte
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
