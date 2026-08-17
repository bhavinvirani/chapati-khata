/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_BASE?: string;
  // Local dev only — production gates via the validate-access edge function.
  readonly VITE_ENTRY_CODE?: string;
  // The VAPID public key, base64url. Public by design, like the anon key.
  // Optional: a build without it simply has no push notifications.
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
