import type { User } from "@supabase/supabase-js";

function capitalizeWord(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function getUserDisplayName(user: User | null) {
  if (!user) return "Usuário";

  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;

  if (metadataName?.trim()) {
    return metadataName.trim();
  }

  const emailPrefix = user.email?.split("@")[0]?.trim();
  if (!emailPrefix) return "Usuário";

  return emailPrefix
    .split(/[._-]+/)
    .filter(Boolean)
    .map(capitalizeWord)
    .join(" ");
}

export function getUserInitials(user: User | null) {
  const displayName = getUserDisplayName(user);
  const parts = displayName.split(/\s+/).filter(Boolean);

  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
