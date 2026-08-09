import * as v from "./validate.mjs";

export const WIZARD_STEPS = [
  { n: 1, title: "Connect your Supabase project" },
  { n: 2, title: "Set the sign-in code" },
  { n: 3, title: "Set your group's price and currency" },
  { n: 4, title: "Deploy credentials" },
  { n: 5, title: "Connect Splitwise (optional)" },
];

const SUPABASE_API_PAGE = "https://supabase.com/dashboard/project/_/settings/api";

export const SETTINGS = [
  {
    id: "supabase-url",
    label: "Supabase project URL",
    help: "Your project's API URL. Public by design — access is controlled by Row-Level Security.",
    targets: [
      { surface: "dotenv", key: "VITE_SUPABASE_URL" },
      { surface: "github-repo", key: "SUPABASE_URL" },
    ],
    validate: v.supabaseUrl,
    obtain: {
      url: SUPABASE_API_PAGE,
      instructions: "Project Settings → API. Copy the Project URL.",
    },
    wizard: { step: 1, required: true },
  },
  {
    id: "supabase-anon-key",
    label: "Supabase anon key",
    help: "The publishable key. Safe to ship in the frontend; the service_role key is the real secret and is never used here.",
    targets: [
      { surface: "dotenv", key: "VITE_SUPABASE_ANON_KEY" },
      { surface: "github-repo", key: "SUPABASE_ANON_KEY" },
    ],
    validate: v.anonKey,
    obtain: {
      url: SUPABASE_API_PAGE,
      instructions: "Project Settings → API. Copy the anon / publishable key — not service_role.",
    },
    wizard: { step: 1, required: true },
  },
  {
    id: "entry-code",
    label: "Entry code",
    help: "The 4-digit code your group types to sign in. Goes to .env for local dev and to Supabase for production, where validate-access checks it.",
    secret: true,
    targets: [
      { surface: "dotenv", key: "VITE_ENTRY_CODE" },
      { surface: "supabase", key: "ENTRY_CODE" },
    ],
    validate: v.fourDigits,
    obtain: null,
    wizard: { step: 2, required: true },
  },
  {
    id: "default-price",
    label: "Default price per chapati",
    help: "Applies to every entry. A day at a different rate is typed in the add box as `50x0.75` instead.",
    targets: [{ surface: "config-file", key: "DEFAULT_PRICE" }],
    validate: v.positiveNumber,
    obtain: null,
    wizard: { step: 3, required: true },
  },
  {
    id: "currency",
    label: "Currency symbol",
    help: "Shown next to every amount in the app.",
    targets: [{ surface: "config-file", key: "CURRENCY" }],
    validate: v.currencySymbol,
    obtain: null,
    wizard: { step: 3, required: true },
  },
  {
    id: "supabase-access-token",
    label: "Supabase access token",
    help: "Lets the deploy workflow push migrations and edge functions. Scoped to the production environment because it grants real write access.",
    secret: true,
    targets: [{ surface: "github-env", key: "SUPABASE_ACCESS_TOKEN" }],
    validate: v.token,
    obtain: {
      url: "https://supabase.com/dashboard/account/tokens",
      instructions: "Generate a new access token and copy it — it is shown only once.",
    },
    wizard: { step: 4, required: true },
  },
  {
    id: "supabase-db-password",
    label: "Supabase database password",
    help: "The password you set when creating the project. Used by the deploy workflow to apply migrations.",
    secret: true,
    targets: [{ surface: "github-env", key: "SUPABASE_DB_PASSWORD" }],
    validate: v.nonEmpty,
    obtain: {
      url: "https://supabase.com/dashboard/project/_/settings/database",
      instructions:
        "Project Settings → Database. Reset the password there if you no longer have it.",
    },
    wizard: { step: 4, required: true },
  },
  {
    id: "splitwise-api-key",
    label: "Splitwise API key",
    help: "Read only by the splitwise edge function — never reaches the browser.",
    secret: true,
    targets: [{ surface: "supabase", key: "SPLITWISE_API_KEY" }],
    validate: v.token,
    obtain: {
      url: "https://dev.splitwise.com/apps",
      instructions:
        "Register an application and copy its API key — not the Consumer Key/Secret, which are for OAuth.",
    },
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-group-id",
    label: "Splitwise group id",
    help: "The group expenses are pushed into. Point it at a disposable test group while trying this out.",
    targets: [{ surface: "supabase", key: "SPLITWISE_GROUP_ID" }],
    validate: v.groupId,
    obtain: {
      url: "https://secure.splitwise.com/groups",
      instructions: "Open the target group. The number in the page URL is the group id.",
    },
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-currency",
    label: "Splitwise currency code",
    help: "The currency the pushed expense is created in, independent of the symbol shown in the app.",
    targets: [{ surface: "config-file", key: "SPLITWISE_CURRENCY" }],
    validate: v.currencyCode,
    obtain: null,
    wizard: { step: 5, required: false },
  },
  {
    id: "splitwise-category",
    label: "Splitwise category",
    help: "The Splitwise category the pushed expense is filed under.",
    targets: [{ surface: "config-file", key: "SPLITWISE_CATEGORY_NAME" }],
    validate: v.nonEmpty,
    obtain: null,
    wizard: { step: 5, required: false },
  },
];

export function settingById(id) {
  return SETTINGS.find((s) => s.id === id);
}
