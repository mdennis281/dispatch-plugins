/**
 * The Settings pane, "Remote hosts": the machines this Dispatch can run chat
 * terminals on, and pairing a new one. Everything it changes goes through the
 * server half's routes (routes.ts), which are the only writers of the `hosts`
 * setting: the generic settings form can't edit a list of objects, so the
 * schema marks it readOnly and this pane owns it.
 *
 * Pairing is three calls, and the pane is built around the one moment that
 * matters: confirming the host key BEFORE anything is sent to the machine.
 *   1. scan: the fingerprint the address presents, to compare with what the
 *      machine prints itself;
 *   2. start: mint this machine's key, get back its restricted
 *      authorized_keys line as a one-liner to run there;
 *   3. finish: after the one-liner ran, or with the account's password, used
 *      once and never stored. Nothing is saved until the new key logs in.
 *
 * Styling is the host's: kit components, and only utility classes the host's
 * own source uses (Tailwind emits nothing for a class it never saw).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, Pencil, Plus, RefreshCw, Server, ShieldCheck, Trash2 } from "lucide-react";
import { defineClientPlugin, type ClientHost } from "@dispatch/plugin-sdk";
import type { ScanResult, StartResult } from "./pairing.js";
import type { HostView } from "./registry.js";
import type { HostConfig } from "./hosts.js";
import { KEY_LINE } from "./key-line.js";
import { RECONNECTING_WORDS } from "./link-status.js";

/** How often the list re-reads the machines' status while the pane is open. */
const POLL_MS = 5_000;

const inputCls =
  "w-full min-w-0 rounded-md border border-line bg-inset px-2.5 py-1.5 text-xs text-primary " +
  "placeholder:text-faint focus:border-accent-line focus:outline-none disabled:opacity-60";
const monoInputCls = `${inputCls} cm-mono`;

/* ------------------------------------------------------------------ api */

interface FinishResult {
  host: HostConfig;
  seenFrom?: string;
  oldKey?: "removed" | "absent" | "left";
}

interface RemoveResult {
  removed: string;
  keyLine: "removed" | "absent" | "unreachable";
  sessionsEnded: number;
  note?: string;
}

/** A route of this plugin; rejects with the server's own reason. */
async function call<T>(host: ClientHost, path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await host.api.fetch(path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const slugPath = (slug: string) => `hosts/${encodeURIComponent(slug)}`;

/* ------------------------------------------------------------- the list */

function useHosts(host: ClientHost) {
  const [hosts, setHosts] = useState<HostView[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await call<{ hosts: HostView[] }>(host, "hosts");
      setHosts(r.hosts);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [host]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    // Another tab, or the other instance, paired or removed one.
    const off = host.settings?.onChange(() => void refresh());
    return () => {
      clearInterval(t);
      off?.();
    };
  }, [host, refresh]);
  return { hosts, error, refresh };
}

function RemoteHostsPage({ host }: { host: ClientHost }) {
  const { Button } = host.ui;
  const { hosts, error, refresh } = useHosts(host);
  const [pairing, setPairing] = useState<PairPrefill | null>(null);
  const [editing, setEditing] = useState<HostView | null>(null);
  const [removing, setRemoving] = useState<HostView | null>(null);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs leading-relaxed text-muted">
          Machines a chat&apos;s terminals can run on, over SSH. Each one is a terminal location,{" "}
          <span className="cm-mono">remote-host/&lt;name&gt;</span>, that a project or a chat can pick; its files sync
          around every command. Prepare the machine first: a dedicated account with Remote Login on (the
          plugin&apos;s README has the Mac walkthrough).
        </p>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" leftIcon={<Plus />} onClick={() => setPairing({})}>
            Pair a machine
          </Button>
        </div>
      </div>

      {error && <ErrorStrip message={`Couldn't read the machines: ${error}`} />}

      {hosts === undefined && !error ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : hosts && hosts.length === 0 ? (
        <div className="rounded-md border border-line bg-inset p-3 text-xs text-muted">No machines paired yet.</div>
      ) : (
        <div className="space-y-2">
          {(hosts ?? []).map((h) => (
            <HostRow
              key={h.slug}
              host={host}
              view={h}
              onChanged={refresh}
              onEdit={() => setEditing(h)}
              onRemove={() => setRemoving(h)}
              onRepair={() =>
                setPairing({
                  slug: h.slug,
                  label: h.label,
                  address: h.addresses[0],
                  addresses: h.addresses,
                  port: h.port,
                  user: h.user,
                  replace: true,
                })
              }
            />
          ))}
        </div>
      )}

      {pairing && (
        <PairDialog
          host={host}
          prefill={pairing}
          onClose={() => {
            setPairing(null);
            void refresh();
          }}
        />
      )}
      {editing && (
        <EditDialog
          host={host}
          view={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          host={host}
          view={removing}
          onClose={() => {
            setRemoving(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  online: "bg-success",
  degraded: "bg-warn",
  offline: "bg-danger",
};

function HostRow(props: {
  host: ClientHost;
  view: HostView;
  onChanged: () => Promise<void>;
  onEdit: () => void;
  onRemove: () => void;
  onRepair: () => void;
}) {
  const { host, view } = props;
  const { IconButton, Tooltip } = host.ui;
  const [checking, setChecking] = useState(false);
  const s = view.status;
  const connecting = reconnecting(view) !== undefined;
  const where = `${view.user}@${view.address ?? view.addresses[0] ?? "?"}${view.port && view.port !== 22 ? `:${view.port}` : ""}`;

  const check = async () => {
    setChecking(true);
    try {
      await call(host, `${slugPath(view.slug)}/check`, "POST");
    } catch (err) {
      host.toast(`${view.label}: ${errText(err)}`, { kind: "warn" });
    } finally {
      setChecking(false);
      await props.onChanged();
    }
  };

  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-start gap-2.5">
        <Tooltip label={statusWords(view)}>
          <span
            aria-label={statusWords(view)}
            className={`mt-1.5 inline-block shrink-0 rounded-full ${connecting ? "bg-faint" : (TONE[s.state] ?? "bg-faint")}`}
            style={{ width: 8, height: 8 }}
          />
        </Tooltip>
        <div className="min-w-0 flex-1 space-y-0.5">
          {/* Wraps rather than truncating both: in a narrow window the label would shrink to "Studio Ma…". */}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium text-primary">{view.label}</span>
            <span className="cm-mono truncate text-2xs text-faint">{view.id}</span>
          </div>
          <div className="cm-mono truncate text-xs text-secondary">{where}</div>
          <div className="text-xs text-muted">{statusLine(view)}</div>
          {view.probe && <div className="text-xs text-muted">{probeLine(view)}</div>}
          {view.probe && missingTools(view).length > 0 && (
            <div className="text-xs text-warn">Not on its PATH: {missingTools(view).join(", ")}</div>
          )}
          {(view.keyLine ?? 1) < KEY_LINE && (
            <div className="text-xs text-warn">
              Paired before 0.4.0: its key lets forwarded ports reach 127.0.0.1 only. Pair again to enable IPv6 dev servers
              (Vite&apos;s <span className="cm-mono">localhost</span> on macOS).
            </div>
          )}
          {view.abandoned && (
            <div className="text-xs text-muted">
              Also there: <span className="cm-mono">~/.dispatch-host/{view.abandoned.id}</span>, left by this Dispatch before its
              id changed{view.abandoned.contactAt ? ` (last in touch ${ago(view.abandoned.contactAt)})` : ""}
              {view.abandoned.running ? `, with ${view.abandoned.running} session${view.abandoned.running === 1 ? "" : "s"} still running` : ""}.
              It is never cleaned up from here, since that id may still be a live Dispatch: delete it there once you know it
              isn&apos;t.
            </div>
          )}
          <div className="cm-mono truncate text-2xs text-faint" title="The machine's host key, pinned at pairing">
            {view.hostKey}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton size="sm" tip="Check now" aria-label={`Check ${view.label} now`} disabled={checking} onClick={() => void check()}>
            <RefreshCw className={checking ? "animate-spin" : undefined} />
          </IconButton>
          <IconButton size="sm" tip="Rename, or change its addresses" aria-label={`Edit ${view.label}`} onClick={props.onEdit}>
            <Pencil />
          </IconButton>
          <IconButton size="sm" tip="Pair again (a new key, or its host key changed)" aria-label={`Pair ${view.label} again`} onClick={props.onRepair}>
            <KeyRound />
          </IconButton>
          <IconButton size="sm" tip="Remove" aria-label={`Remove ${view.label}`} onClick={props.onRemove}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The words for a link that is (re)connecting, not failing. It reports those
 * as "degraded" (a new link, changed settings) or "offline" (a dropped one, while
 * it retries at once), so match the exact details, whatever the state.
 */
function reconnecting(v: HostView): string | undefined {
  return v.status.state === "online" || !v.status.detail ? undefined : RECONNECTING_WORDS[v.status.detail];
}

function statusWords(v: HostView): string {
  const s = v.status;
  if (s.state === "online") return "Online";
  const r = reconnecting(v);
  if (r) return r;
  if (s.state === "degraded") return `Degraded${s.detail ? `: ${s.detail}` : ""}`;
  return `Offline${s.detail ? `: ${s.detail}` : ""}`;
}

function statusLine(v: HostView): string {
  const s = v.status;
  const seen = s.lastSeenAt ? `last seen ${ago(s.lastSeenAt)}` : undefined;
  if (s.state === "online") return ["Online", seen].filter(Boolean).join(" · ");
  return [statusWords(v), seen].filter(Boolean).join(" · ");
}

function probeLine(v: HostView): string {
  const p = v.probe!;
  const os = [p.os.name ?? p.platform, p.os.version].filter(Boolean).join(" ");
  const disk = typeof p.freeDiskBytes === "number" ? `${Math.round(p.freeDiskBytes / 1024 ** 3)} GB free` : undefined;
  const tools = [p.tools.git && `git ${p.tools.git}`, p.tools.node && `node ${p.tools.node}`, p.tools.pnpm && `pnpm ${p.tools.pnpm}`]
    .filter(Boolean)
    .join(", ");
  return [os, p.arch, disk, tools].filter(Boolean).join(" · ");
}

function missingTools(v: HostView): string[] {
  const t = v.probe?.tools;
  if (!t) return [];
  return (["git", "node", "pnpm"] as const).filter((k) => !t[k]);
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/* -------------------------------------------------------------- pairing */

interface PairPrefill {
  slug?: string;
  label?: string;
  address?: string;
  port?: number;
  user?: string;
  /**
   * Every address the machine has now, when pairing it again. Sent with the
   * new pairing so its saved list survives; the scanned address goes first.
   */
  addresses?: string[];
  /** Pairing an already-paired machine again: a new key, or its host key changed. */
  replace?: boolean;
}

type Step =
  | { at: "where" }
  | { at: "confirm"; scan: ScanResult }
  | { at: "install"; scan: ScanResult; started: StartResult }
  | { at: "done"; done: FinishResult };

function PairDialog({ host, prefill, onClose }: { host: ClientHost; prefill: PairPrefill; onClose: () => void }) {
  const { Button, Dialog, Field, Toggle } = host.ui;
  const [step, setStep] = useState<Step>({ at: "where" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(prefill.address ?? "");
  const [port, setPort] = useState(String(prefill.port ?? 22));
  const [slug, setSlug] = useState(prefill.slug ?? "");
  const [label, setLabel] = useState(prefill.label ?? "");
  const [user, setUser] = useState(prefill.user ?? "dispatch");
  const [allowFrom, setAllowFrom] = useState("");
  const [matches, setMatches] = useState(false);
  const [password, setPassword] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  // A pairing left half-done holds a minted key in the server's memory until
  // it expires; closing the dialog lets it go now.
  const close = () => {
    if (step.at === "install") void call(host, "pair/cancel", "POST", { pairingId: step.started.pairingId }).catch(() => {});
    onClose();
  };

  const scan = () =>
    run(async () => {
      const r = await call<ScanResult>(host, "pair/scan", "POST", { address: address.trim(), port: port.trim() || undefined });
      if (!slug) setSlug(suggestSlug(address));
      setAllowFrom(r.suggestedAllowFrom.join(", "));
      setMatches(false);
      setStep({ at: "confirm", scan: r });
    });

  const start = (scanned: ScanResult) =>
    run(async () => {
      const started = await call<StartResult>(host, "pair/start", "POST", {
        slug: slug.trim(),
        label: label.trim() || undefined,
        address: scanned.address,
        port: scanned.port,
        user: user.trim(),
        hostKey: scanned.fingerprint,
        hostKeyType: scanned.keyType,
        allowFrom: splitList(allowFrom),
        ...(prefill.addresses?.length ? { addresses: prefill.addresses } : {}),
        ...(prefill.replace ? { replace: true } : {}),
      });
      setStep({ at: "install", scan: scanned, started });
    });

  const finish = (pairingId: string, withPassword: boolean) =>
    run(async () => {
      const done = await call<FinishResult>(host, "pair/finish", "POST", {
        pairingId,
        ...(withPassword ? { password } : {}),
      });
      setPassword("");
      setStep({ at: "done", done });
    });

  let body: ReactNode;
  let footer: ReactNode;
  if (step.at === "where") {
    body = (
      <div className="space-y-3">
        <Field label="Address" hint="Its host name or IP address, as this computer reaches it">
          <input
            className={monoInputCls}
            value={address}
            autoFocus
            placeholder="10.0.10.16"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && address.trim() && void scan()}
          />
        </Field>
        <Field label="SSH port">
          <input className={monoInputCls} style={{ width: 96 }} value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          Next, Dispatch reads the key the machine identifies itself with. It logs in to nothing and sends nothing.
        </p>
      </div>
    );
    footer = (
      <>
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy || !address.trim()} onClick={() => void scan()}>
          {busy ? "Looking…" : "Look up its host key"}
        </Button>
      </>
    );
  } else if (step.at === "confirm") {
    const s = step.scan;
    const keyFile = `/etc/ssh/ssh_host_${keyFileName(s.keyType)}_key.pub`;
    body = (
      <div className="space-y-3">
        <div className="rounded-md border border-accent-line bg-accent-ghost/40 p-3">
          <p className="text-xs text-secondary">
            <span className="cm-mono">{s.address}</span> presents this {s.keyType} host key:
          </p>
          <p className="cm-mono mt-1 text-sm text-primary" style={{ wordBreak: "break-all" }}>
            {s.fingerprint}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            On the machine itself, run <span className="cm-mono text-secondary">ssh-keygen -lf {keyFile}</span> and compare. If
            they differ, something between here and there is answering in its place: stop.
          </p>
        </div>
        <Toggle checked={matches} onChange={setMatches} label="It matches what the machine shows" />
        <Field label="Name" hint={<>The location&apos;s id, remote-host/{slug.trim() || "<name>"}. Lowercase letters, digits and dashes; fixed once paired.</>} required>
          <input className={monoInputCls} value={slug} disabled={prefill.replace} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Label" hint="What Dispatch shows; rename it any time">
          <input className={inputCls} value={label} placeholder={slug || "CVX Mac"} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Account" hint="The dedicated account on the machine, not your own" required>
          <input className={monoInputCls} value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
        <Field label="Allowed from" hint="This computer's addresses as the machine sees them. The key works only from these (comma-separated)." required>
          <input className={monoInputCls} value={allowFrom} onChange={(e) => setAllowFrom(e.target.value)} />
        </Field>
      </div>
    );
    footer = (
      <>
        <Button size="sm" variant="ghost" onClick={() => setStep({ at: "where" })}>
          Back
        </Button>
        <Button
          size="sm"
          variant="primary"
          leftIcon={<ShieldCheck />}
          disabled={busy || !matches || !slug.trim() || !user.trim() || !allowFrom.trim()}
          onClick={() => void start(s)}
        >
          {busy ? "Making its key…" : "Trust it and continue"}
        </Button>
      </>
    );
  } else if (step.at === "install") {
    const { started } = step;
    body = (
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-muted">
          Dispatch made a key for this machine. Put it in <span className="cm-mono">~{user}/.ssh/authorized_keys</span> there,
          one of two ways. It only lets this computer run Dispatch&apos;s sessions, from the addresses you allowed.
        </p>
        <div className="space-y-2">
          <SectionTitle>Run this on the machine, logged in as {user}</SectionTitle>
          <CopyBox host={host} text={started.oneLiner} />
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void finish(started.pairingId, false)}>
              {busy && !password ? "Checking…" : "I ran it, finish"}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <SectionTitle>Or give {user}&apos;s password once</SectionTitle>
          <p className="text-xs leading-relaxed text-muted">
            Sent only to the machine presenting the key you confirmed, used to add the line, and never stored.
          </p>
          <div className="flex items-center gap-2">
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              value={password}
              placeholder="password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && password && void finish(started.pairingId, true)}
            />
            <Button size="sm" disabled={busy || !password} onClick={() => void finish(started.pairingId, true)}>
              {busy && password ? "Adding…" : "Use the password"}
            </Button>
          </div>
        </div>
        <p className="text-2xs text-faint">
          This pairing expires at {new Date(started.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
        </p>
      </div>
    );
    footer = (
      <Button size="sm" variant="ghost" onClick={close}>
        Cancel
      </Button>
    );
  } else {
    const { done } = step;
    body = (
      <div className="space-y-2">
        <p className="text-sm text-primary">
          Paired <span className="font-medium">{done.host.label}</span> as{" "}
          <span className="cm-mono">remote-host/{done.host.slug}</span>.
        </p>
        <p className="text-xs leading-relaxed text-muted">
          It connects now and installs dispatch-host there; its status shows in the list. Pick it as a terminal location in a
          project&apos;s settings, or for one chat.
        </p>
        {done.seenFrom && (
          <p className="text-xs text-muted">
            It saw this computer as <span className="cm-mono">{done.seenFrom}</span>.
          </p>
        )}
        {done.oldKey === "removed" && <p className="text-xs text-muted">The old key was taken off the machine.</p>}
        {done.oldKey === "left" && (
          <p className="text-xs text-warn">
            The old key couldn&apos;t be taken off the machine. Delete its line from ~{done.host.user}/.ssh/authorized_keys there.
          </p>
        )}
      </div>
    );
    footer = (
      <Button size="sm" variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      icon={<Server />}
      title={prefill.replace ? `Pair ${prefill.label ?? prefill.slug} again` : "Pair a machine"}
      description={STEP_TEXT[step.at]}
      width={520}
      footer={<div className="flex w-full items-center justify-end gap-2">{footer}</div>}
    >
      <div className="space-y-3">
        {body}
        <ErrorStrip message={error} />
      </div>
    </Dialog>
  );
}

const STEP_TEXT: Record<Step["at"], string> = {
  where: "Step 1 of 3: where it is",
  confirm: "Step 2 of 3: is it really that machine?",
  install: "Step 3 of 3: let this computer in",
  done: "Done",
};

function keyFileName(type: string): string {
  if (type === "ssh-ed25519") return "ed25519";
  if (type.startsWith("ecdsa")) return "ecdsa";
  if (type === "ssh-rsa" || type.startsWith("rsa")) return "rsa";
  return "ed25519";
}

/** A name from a host name (`cvx-mac.lan` → `cvx-mac`); nothing from an IP address. */
function suggestSlug(address: string): string {
  const a = address.trim().toLowerCase();
  if (!a || /^[0-9.]+$/.test(a) || a.includes(":")) return "";
  return (a.split(".")[0] ?? "").replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 48);
}

function splitList(s: string): string[] {
  return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

/* --------------------------------------------------- rename and remove */

function EditDialog({ host, view, onClose }: { host: ClientHost; view: HostView; onClose: () => void }) {
  const { Button, Dialog, Field } = host.ui;
  const [label, setLabel] = useState(view.label);
  const [addresses, setAddresses] = useState(view.addresses.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(host, slugPath(view.slug), "PUT", { label: label.trim(), addresses: splitList(addresses) });
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon={<Pencil />}
      title={`Edit ${view.label}`}
      description={<span className="cm-mono">{view.id}</span>}
      width={460}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !label.trim() || !addresses.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Label" hint={`Its name stays ${view.id}, so chats and projects keep pointing at it`}>
          <input className={inputCls} value={label} autoFocus onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Addresses" hint="Tried in order, comma-separated. Its pinned host key decides which one is really it.">
          <input className={monoInputCls} value={addresses} onChange={(e) => setAddresses(e.target.value)} />
        </Field>
        <ErrorStrip message={error} />
      </div>
    </Dialog>
  );
}

function RemoveDialog({ host, view, onClose }: { host: ClientHost; view: HostView; onClose: () => void }) {
  const { Button, Dialog } = host.ui;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<RemoveResult>(host, slugPath(view.slug), "DELETE");
      if (r.note) host.toast(`Removed ${view.label}, but its key is still on the machine`, { kind: "warn", detail: r.note });
      else host.toast(`Removed ${view.label}`, { kind: "info" });
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
      icon={<Trash2 />}
      title={`Remove ${view.label}?`}
      width={460}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </div>
      }
    >
      <div className="space-y-2 text-xs leading-relaxed text-muted">
        <p>
          This ends this Dispatch&apos;s terminals on it, takes this computer&apos;s key out of{" "}
          <span className="cm-mono">~{view.user}/.ssh/authorized_keys</span> there, and deletes the key here. Chats and projects
          that run terminals on <span className="cm-mono">{view.id}</span> are refused until you pick another location.
        </p>
        <p>Files under ~/.dispatch-host on the machine stay; delete them there if you want them gone.</p>
        <ErrorStrip message={error} />
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- bits */

function CopyBox({ host, text }: { host: ClientHost; text: string }) {
  const { Button } = host.ui;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <textarea
        className={`${monoInputCls} resize-none`}
        readOnly
        rows={3}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        size="sm"
        leftIcon={copied ? <Check /> : <Copy />}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">{children}</div>;
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
      id: "hosts",
      label: "Remote hosts",
      blurb: "Machines chat terminals can run on",
      icon: Server,
      render: () => <RemoteHostsPage host={host} />,
    });
  },
});
