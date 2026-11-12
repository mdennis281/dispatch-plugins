/**
 * The Settings pane, "Proxmox containers": whether terminals can run now, the
 * warnings worth acting on (an unpinned template host key, a vmid range
 * nearly full), and the containers made before 0.2 that are waiting for their
 * chats, with the two things a human can do about one that won't rescue.
 * Everything comes from the server half's routes (routes.ts); the settings
 * themselves stay in the generic form under Plugins → Proxmox terminal.
 *
 * Styling is the host's: kit components, and only utility classes the host's
 * own source uses (Tailwind emits nothing for a class it never saw).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Box, RefreshCw, SkipForward, Trash2 } from "lucide-react";
import { defineClientPlugin, type ClientHost } from "@dispatch/plugin-sdk";
import type { LegacyView, Overview } from "./backend.js";

/** How often the pane re-reads while it is open. */
const POLL_MS = 10_000;

/** A route of this plugin; rejects with the server's own reason. */
async function call<T>(host: ClientHost, path: string, method = "GET"): Promise<T> {
  const res = await host.api.fetch(path, { method });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const legacyPath = (chatId: string, action: string) => `legacy/${encodeURIComponent(chatId)}/${action}`;

function useOverview(host: ClientHost) {
  const [view, setView] = useState<Overview | undefined>();
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setView(await call<Overview>(host, "overview"));
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [host]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const off = host.settings?.onChange(() => void refresh());
    return () => {
      clearInterval(t);
      off?.();
    };
  }, [host, refresh]);
  return { view, error, refresh };
}

const TONE: Record<string, string> = { online: "bg-success", offline: "bg-danger" };

function ContainersPage({ host }: { host: ClientHost }) {
  const { Button } = host.ui;
  const { view, error, refresh } = useOverview(host);
  const [acting, setActing] = useState<{ row: LegacyView; action: "skip" | "destroy" } | null>(null);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs leading-relaxed text-muted">
          Each chat that runs terminals on <span className="cm-mono">proxmox</span> gets its own container, a linked clone of
          the template, run through Remote host. The settings are under Plugins → Proxmox terminal.
        </p>
        <Button size="sm" leftIcon={<RefreshCw />} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      <ErrorStrip message={error ? `Couldn't read the containers: ${error}` : null} />
      {view === undefined && !error && <p className="text-xs text-muted">Loading…</p>}

      {view && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-block h-2 w-2 rounded-full ${TONE[view.status.state] ?? "bg-warn"}`} />
            <span className="text-primary">{view.status.state === "online" ? "Terminals can run" : "Terminals are refused"}</span>
            {view.status.detail && <span className="text-muted">— {view.status.detail}</span>}
          </div>

          {!view.hostKeyPinned && (
            <WarnStrip>
              The template&apos;s host key isn&apos;t pinned, so a container is trusted because the Proxmox API gave its address,
              and remote-host says so on every connect. Set <span className="cm-mono">templateHostKey</span> to the template&apos;s
              ED25519 fingerprint (<span className="cm-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> on it).
            </WarnStrip>
          )}
          {view.range.warn && (
            <WarnStrip>
              {view.range.used} of the {view.range.size} vmids in {view.range.start}–{view.range.end} are taken. Delete chats you
              are done with, or widen the range, before new chats can&apos;t get a container.
            </WarnStrip>
          )}
          {view.apiError && <WarnStrip>The Proxmox API didn&apos;t answer: {view.apiError}</WarnStrip>}

          <div className="space-y-2">
            <SectionTitle>Containers from before 0.2</SectionTitle>
            {view.legacy.length === 0 ? (
              <div className="rounded-md border border-line bg-inset p-3 text-xs text-muted">None waiting.</div>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-muted">
                  {view.legacy.length} legacy container{view.legacy.length === 1 ? "" : "s"} waiting for {view.legacy.length === 1 ? "its chat" : "their chats"}.
                  At a chat&apos;s next command, its old checkout&apos;s unsaved work is saved into a git ref in the chat&apos;s
                  repository, then the chat carries on. Until then each one stays stopped and is never destroyed for being
                  unused. Uninstalling this plugin destroys {view.legacy.length === 1 ? "it" : "them"} unrescued.
                </p>
                {view.legacy.map((row) => (
                  <LegacyRow key={row.chatId} host={host} row={row} onAct={(action) => setActing({ row, action })} />
                ))}
              </>
            )}
          </div>
        </>
      )}

      {acting && (
        <ConfirmDialog
          host={host}
          row={acting.row}
          action={acting.action}
          onClose={() => {
            setActing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function LegacyRow({ host, row, onAct }: { host: ClientHost; row: LegacyView; onAct: (a: "skip" | "destroy") => void }) {
  const { Button } = host.ui;
  const state = row.rescuing
    ? `rescuing${row.phase ? ` (${row.phase})` : ""}`
    : row.failures
      ? `rescue failed ${row.failures}×`
      : "waiting";
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-inset p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Box className="h-3.5 w-3.5 text-faint" />
        <span className="cm-mono text-primary">{row.vmid}</span>
        <span className="cm-mono text-muted">{row.hostname}</span>
        {row.status && <span className="text-faint">{row.status}</span>}
        <span className="text-muted">· chat <span className="cm-mono">{row.chatId}</span> · {state}</span>
        <div className="ml-auto flex items-center gap-2">
          {row.canSkip && (
            <Button size="sm" leftIcon={<SkipForward />} disabled={row.rescuing} onClick={() => onAct("skip")}>
              Skip rescue
            </Button>
          )}
          <Button size="sm" variant="danger" leftIcon={<Trash2 />} disabled={row.rescuing} onClick={() => onAct("destroy")}>
            Destroy without rescue
          </Button>
        </div>
      </div>
      {row.lastError && <div className="text-warn">Last attempt: {row.lastError}</div>}
    </div>
  );
}

function ConfirmDialog(props: { host: ClientHost; row: LegacyView; action: "skip" | "destroy"; onClose: () => void }) {
  const { host, row, action, onClose } = props;
  const { Button, Dialog } = host.ui;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destroy = action === "destroy";
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(host, legacyPath(row.chatId, destroy ? "destroy" : "skip-rescue"), "POST");
      host.toast(destroy ? `Container ${row.vmid} destroyed` : `Rescue of container ${row.vmid} skipped`, { kind: "info" });
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon={destroy ? <Trash2 /> : <SkipForward />}
      title={destroy ? `Destroy container ${row.vmid} without rescue?` : `Skip the rescue of container ${row.vmid}?`}
      width={460}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant={destroy ? "danger" : "primary"} disabled={busy} onClick={() => void go()}>
            {busy ? "Working…" : destroy ? "Destroy" : "Skip rescue"}
          </Button>
        </div>
      }
    >
      <div className="space-y-2 text-xs leading-relaxed text-muted">
        {destroy ? (
          <p>
            The container and everything on it go now, including any edits in its old checkout that never came back to this
            computer. Chat <span className="cm-mono">{row.chatId}</span>&apos;s next command gets a new container.
          </p>
        ) : (
          <p>
            Chat <span className="cm-mono">{row.chatId}</span>&apos;s next command goes ahead on this container without saving
            its old checkout first. The old checkout stays on the container until the container is destroyed, and from now on
            it can be destroyed for being unused, like any other.
          </p>
        )}
        <ErrorStrip message={error} />
      </div>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">{children}</div>;
}

function WarnStrip({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-line bg-inset px-2.5 py-1.5 text-xs text-warn">{children}</div>;
}

function ErrorStrip({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-ghost px-2.5 py-1.5 text-xs text-danger">
      {message}
    </div>
  );
}

export default defineClientPlugin({
  activate(host) {
    host.slots.settingsSection({
      id: "containers",
      label: "Proxmox containers",
      blurb: "Per-chat terminal containers",
      icon: Box,
      render: () => <ContainersPage host={host} />,
    });
  },
});
