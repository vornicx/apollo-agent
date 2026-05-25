import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <div className="mt-8 rounded-lg border border-border bg-card p-6">
          <h2 className="font-semibold">Account</h2>
          <dl className="mt-4 grid grid-cols-[120px_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Email</dt><dd>{user?.email}</dd>
            <dt className="text-muted-foreground">User ID</dt><dd className="font-mono text-xs">{user?.id}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
