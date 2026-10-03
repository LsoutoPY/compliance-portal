import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { UserAccessType } from "@/config/navigation";

export type ManagedUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  access_type: UserAccessType;
  is_active: boolean;
  menu_keys: string[];
};

type ListResponse = { success: boolean; users?: ManagedUser[]; error?: string };
type UpdateResponse = { success: boolean; error?: string };

export type UpdateUserAccessPayload = {
  user_id: string;
  full_name: string | null;
  access_type: UserAccessType;
  is_active: boolean;
  menu_keys: string[];
};

async function invokeManageUserAccess<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("manage-user-access", { body });
  if (error) throw new Error(error.message);
  return data as T;
}

export function useManagedUsers(enabled: boolean) {
  return useQuery({
    queryKey: ["managed-users"],
    queryFn: async () => {
      const res = await invokeManageUserAccess<ListResponse>({ action: "list" });
      if (!res?.success) throw new Error(res?.error ?? "Falha ao listar usuários.");
      return res.users ?? [];
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateUserAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateUserAccessPayload) => {
      const res = await invokeManageUserAccess<UpdateResponse>({
        action: "update",
        ...payload,
      });
      if (!res?.success) throw new Error(res?.error ?? "Falha ao salvar usuário.");
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["managed-users"] });
    },
  });
}
