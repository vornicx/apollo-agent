import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listApiKeys, upsertApiKey, deleteApiKey } from "@/lib/keys.functions";
import { PROVIDERS, CHAT_PROVIDERS } from "@/lib/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/keys")({ component: KeysPage });

function KeysPage() {
  const list = useServerFn(listApiKeys);
  const upsert = useServerFn(upsertApiKey);
  const del = useServerFn(deleteApiKey);
  const qc = useQueryClient();

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => list(),
  });

  const [provider, setProvider] = useState<string>(CHAT_PROVIDERS[0].id);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const addMutation = useMutation({
    mutationFn: () => upsert({ data: { provider, label, api_key: apiKey } }),
    onSuccess: () => {
      toast.success("API key saved");
      setApiKey(""); setLabel("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save"),
  });

  const delMutation = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const currentProvider = PROVIDERS.find((p) => p.id === provider)!;

  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stored encrypted at rest. Keys never leave the server — only a masked preview is shown here.
        </p>

        <div className="mt-8 rounded-lg border border-border bg-card p-6">
          <h2 className="flex items-center gap-2 font-semibold"><Plus className="h-4 w-4" /> Add key</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHAT_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Label (optional)</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="personal, work…" />
            </div>
            <div className="sm:col-span-2">
              <Label>API key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={currentProvider.keyHint}
                className="font-mono"
              />
              <a
                href={currentProvider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Get a key <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
          <Button
            className="mt-4"
            onClick={() => addMutation.mutate()}
            disabled={!apiKey || addMutation.isPending}
          >
            {addMutation.isPending ? "Saving…" : "Save key"}
          </Button>
        </div>

        <div className="mt-10">
          <h2 className="font-semibold">Saved keys</h2>
          {isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {keys.map((k) => {
                const meta = PROVIDERS.find((p) => p.id === k.provider);
                return (
                  <div key={k.id} className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                    <div>
                      <div className="text-sm font-medium">{meta?.name ?? k.provider}{k.label && <span className="ml-2 text-muted-foreground">· {k.label}</span>}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{k.masked}</div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => delMutation.mutate(k.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
