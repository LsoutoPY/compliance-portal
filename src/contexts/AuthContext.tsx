import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { INACTIVITY_TIMEOUT_MS, useInactivityTimeout } from "@/hooks/useInactivityTimeout";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  recoveryMode: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string
  ) => Promise<{ error: string | null; message: string | null }>;
  signOut: () => Promise<void>;
  resetPasswordForEmail: (
    email: string
  ) => Promise<{ error: string | null; message: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  updatePasswordWithVerification: (
    currentPassword: string,
    newPassword: string
  ) => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function getPasswordResetRedirectUrl() {
  return `${window.location.origin}/redefinir-senha`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
      })
      .catch((err) => {
        console.error("[Auth] Falha ao restaurar sessão:", err);
        setSession(null);
      })
      .finally(() => {
        setLoading(false);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      setRecoveryMode(event === "PASSWORD_RECOVERY");
      setLoading(false);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.includes("Invalid login credentials")) {
        return { error: "E-mail ou senha incorretos." };
      }
      if (error.message.includes("Email not confirmed")) {
        return { error: "E-mail não confirmado. Verifique sua caixa de entrada." };
      }
      return { error: "Erro ao fazer login. Tente novamente." };
    }
    return { error: null };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName.trim(),
        },
      },
    });

    if (error) {
      if (error.message.toLowerCase().includes("already registered")) {
        return { error: "Já existe uma conta cadastrada com este e-mail.", message: null };
      }

      if (error.message.toLowerCase().includes("password")) {
        return { error: "A senha precisa atender aos critérios mínimos do Supabase.", message: null };
      }

      return { error: "Erro ao criar conta. Tente novamente.", message: null };
    }

    const requiresEmailConfirmation = !data.session;

    return {
      error: null,
      message: requiresEmailConfirmation
        ? "Cadastro realizado. Verifique seu e-mail para confirmar a conta antes de entrar."
        : "Cadastro realizado com sucesso. Você já pode acessar a plataforma.",
    };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      // Sessão inválida/expirada no servidor (403): limpa localmente mesmo assim
      console.warn("[Auth] signOut remoto falhou, encerrando sessão local:", error.message);
      await supabase.auth.signOut({ scope: "local" });
    }
    setSession(null);
    setRecoveryMode(false);
  };

  const resetPasswordForEmail = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: getPasswordResetRedirectUrl(),
    });

    if (error) {
      return { error: "Não foi possível enviar o e-mail de recuperação. Tente novamente.", message: null };
    }

    return {
      error: null,
      message:
        "Se existir uma conta com este e-mail, você receberá um link para redefinir sua senha.",
    };
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      if (error.message.toLowerCase().includes("password")) {
        return { error: "A nova senha precisa atender aos critérios mínimos do Supabase." };
      }
      return { error: "Não foi possível atualizar a senha. Tente novamente." };
    }

    setRecoveryMode(false);
    return { error: null };
  };

  const updatePasswordWithVerification = async (currentPassword: string, newPassword: string) => {
    const email = session?.user?.email;
    if (!email) {
      return { error: "Sessão inválida. Faça login novamente." };
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (signInError) {
      return { error: "Senha atual incorreta." };
    }

    return updatePassword(newPassword);
  };

  const handleInactivityTimeout = useCallback(async () => {
    toast.info("Sessão encerrada por inatividade (1 hora). Faça login novamente.");
    const { error } = await supabase.auth.signOut();
    if (error) {
      await supabase.auth.signOut({ scope: "local" });
    }
    setSession(null);
  }, []);

  useInactivityTimeout({
    enabled: !!session,
    timeoutMs: INACTIVITY_TIMEOUT_MS,
    onTimeout: handleInactivityTimeout,
  });

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        recoveryMode,
        signIn,
        signUp,
        signOut,
        resetPasswordForEmail,
        updatePassword,
        updatePasswordWithVerification,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
