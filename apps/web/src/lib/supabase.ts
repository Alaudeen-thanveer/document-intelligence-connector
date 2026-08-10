import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env",
  );
}

export const supabase = createClient(url, anonKey);

export const functionsUrl =
  (import.meta.env.VITE_FUNCTIONS_URL as string | undefined) ??
  `${url}/functions/v1`;
