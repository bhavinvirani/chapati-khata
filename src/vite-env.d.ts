/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_BASE?: string;
  // Local dev only — production gates via the validate-access edge function.
  readonly VITE_ENTRY_CODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
