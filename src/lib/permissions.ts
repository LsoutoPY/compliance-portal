import type { UserAccessType } from "@/config/navigation";
import { resolveMenuKeyFromPath } from "@/config/navigation";

export type UserProfile = {
  id: string;
  full_name: string | null;
  access_type: UserAccessType;
  is_active: boolean;
};

export type UserPermissions = {
  profile: UserProfile | null;
  menuKeys: Set<string> | "all";
  canWrite: boolean;
  canManageUsers: boolean;
  isActive: boolean;
  loading: boolean;
};

export function buildPermissions(
  profile: UserProfile | null,
  menuKeysList: string[],
  loading: boolean
): UserPermissions {
  if (!profile) {
    return {
      profile: null,
      menuKeys: new Set(),
      canWrite: false,
      canManageUsers: false,
      isActive: false,
      loading,
    };
  }

  const isCompleto = profile.access_type === "completo";

  return {
    profile,
    menuKeys: isCompleto ? "all" : new Set(menuKeysList),
    canWrite: isCompleto && profile.is_active,
    canManageUsers: isCompleto && profile.is_active,
    isActive: profile.is_active,
    loading,
  };
}

/** Mapeamento de menu_keys legadas para a key atual (retrocompatibilidade). */
const LEGACY_MENU_KEY_ALIASES: Record<string, string> = {
  "credito.dashboard":    "credito.matriz",
  "credito.monitoramento": "credito.matriz",
  "credito.consolidado":  "credito.matriz",
  "credito.safras":       "credito.matriz",
};

export function canAccessMenuKey(
  menuKey: string | null,
  permissions: Pick<UserPermissions, "menuKeys" | "isActive">
): boolean {
  if (!permissions.isActive) return false;
  if (!menuKey || menuKey === "hub") return true;
  if (permissions.menuKeys === "all") return true;
  // Checa a key diretamente ou pelo alias legado
  const canonical = LEGACY_MENU_KEY_ALIASES[menuKey] ?? menuKey;
  return permissions.menuKeys.has(canonical) || permissions.menuKeys.has(menuKey);
}

export function canAccessPath(
  pathname: string,
  permissions: Pick<UserPermissions, "menuKeys" | "isActive" | "canManageUsers">
): boolean {
  const menuKey = resolveMenuKeyFromPath(pathname);
  if (
    menuKey === "configuracoes.hub" ||
    menuKey === "configuracoes.usuarios" ||
    menuKey === "configuracoes.monitoramento"
  ) {
    return permissions.canManageUsers;
  }
  if (menuKey === "conta") {
    return permissions.isActive;
  }
  if (menuKey === null) {
    return permissions.menuKeys === "all";
  }
  return canAccessMenuKey(menuKey, permissions);
}

export function filterMenuKeysForConsulta(
  menuKeys: Set<string>,
  includeWriteOnly: boolean
): Set<string> {
  if (includeWriteOnly) return menuKeys;
  // writeOnly items are filtered at nav render time via NAV_REGISTRY.writeOnly
  return menuKeys;
}
