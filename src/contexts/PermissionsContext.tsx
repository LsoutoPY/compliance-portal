import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  buildPermissions,
  canAccessPath,
  type UserPermissions,
  type UserProfile,
} from "@/lib/permissions";
import { resolveMenuKeyFromPath } from "@/config/navigation";

interface PermissionsContextValue extends UserPermissions {
  refetch: () => Promise<void>;
  canAccessPath: (pathname: string) => boolean;
  canAccessMenuKey: (menuKey: string) => boolean;
}

const PermissionsContext = createContext<PermissionsContextValue | undefined>(undefined);

async function fetchUserPermissions(userId: string) {
  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("id, full_name, access_type, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.warn("[Permissions] Perfil indisponível neste projeto:", profileError.message);
    return { profile: null, menuKeysList: [] as string[] };
  }

  if (!profile) {
    return { profile: null, menuKeysList: [] as string[] };
  }

  if (profile.access_type === "completo") {
    return { profile: profile as UserProfile, menuKeysList: [] as string[] };
  }

  const { data: menuRows, error: menuError } = await supabase
    .from("user_menu_permissions")
    .select("menu_key")
    .eq("user_id", userId);

  if (menuError) throw menuError;

  return {
    profile: profile as UserProfile,
    menuKeysList: (menuRows ?? []).map((row) => row.menu_key),
  };
}

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const {
    data,
    isLoading,
    isFetching,
    refetch: refetchQuery,
  } = useQuery({
    queryKey: ["user-permissions", user?.id],
    queryFn: () => fetchUserPermissions(user!.id),
    enabled: !!user?.id,
    staleTime: 60_000,
    retry: 1,
  });

  const permissions = useMemo(() => {
    const fallbackProfile = {
      id: user?.id ?? "anon",
      full_name: user?.email ?? "Risco CVPAR",
      access_type: "completo" as const,
      is_active: true,
    };
    return buildPermissions(
      data?.profile ?? fallbackProfile,
      data?.menuKeysList ?? [],
      authLoading || (!!user && (isLoading || isFetching))
    );
  }, [data, authLoading, isLoading, isFetching, user]);

  const refetch = useCallback(async () => {
    await refetchQuery();
    await queryClient.invalidateQueries({ queryKey: ["user-permissions", user?.id] });
  }, [refetchQuery, queryClient, user?.id]);

  const checkPath = useCallback(
    (pathname: string) => canAccessPath(pathname, permissions),
    [permissions]
  );

  const checkMenuKey = useCallback(
    (menuKey: string) => {
      if (!permissions.isActive) return false;
      if (menuKey === "hub") return true;
      if (permissions.menuKeys === "all") return true;
      return permissions.menuKeys.has(menuKey);
    },
    [permissions]
  );

  const value = useMemo<PermissionsContextValue>(
    () => ({
      ...permissions,
      refetch,
      canAccessPath: checkPath,
      canAccessMenuKey: checkMenuKey,
    }),
    [permissions, refetch, checkPath, checkMenuKey]
  );

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error("usePermissions must be used within PermissionsProvider");
  return ctx;
}

export function useCanWrite() {
  const { canWrite } = usePermissions();
  return canWrite;
}

/** Resolve se a rota atual é permitida — útil em guards */
export function useRouteAccess(pathname: string) {
  const { canAccessPath, loading, isActive } = usePermissions();
  const menuKey = resolveMenuKeyFromPath(pathname);
  return {
    allowed: canAccessPath(pathname),
    menuKey,
    loading,
    isActive,
  };
}
