import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const handledRef = useRef(false);
  const [message, setMessage] = useState("Completing sign in...");

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    async function completeAuth() {
      const params = new URLSearchParams(window.location.search);
      const authError = params.get("error_description") ?? params.get("error");

      if (authError) {
        toast.error(authError);
        navigate({ to: "/login", replace: true });
        return;
      }

      const code = params.get("code");

      try {
        if (code) {
          setMessage("Securing your Google session...");
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) throw new Error("No authentication session was returned.");
        }

        navigate({ to: "/missions", replace: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Google sign-in failed");
        navigate({ to: "/login", replace: true });
      }
    }

    void completeAuth();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {message}
    </div>
  );
}
