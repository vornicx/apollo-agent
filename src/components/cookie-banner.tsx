import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "ai-hub:cookie-ack";

export function CookieBanner() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      /* storage unavailable — skip */
    }
  }, []);

  if (!open) return null;

  function accept() {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* noop */ }
    setOpen(false);
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-lg border border-border bg-card/95 p-4 shadow-lg backdrop-blur">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground sm:text-sm">
          We use only strictly necessary cookies to keep you signed in. No tracking, no ads.{" "}
          <Link to="/cookies" className="text-primary underline">Learn more</Link>.
        </p>
        <Button size="sm" onClick={accept}>Got it</Button>
      </div>
    </div>
  );
}
