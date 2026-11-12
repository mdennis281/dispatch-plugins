const m$2 = window.__dispatch.deps["jsxRuntime"];
const pick$2 = (k) => m$2[k];
const Fragment = /* @__PURE__ */ pick$2("Fragment");
const jsx = /* @__PURE__ */ pick$2("jsx");
const jsxs = /* @__PURE__ */ pick$2("jsxs");
const m$1 = window.__dispatch.deps["react"];
const pick$1 = (k) => m$1[k];
const useCallback = /* @__PURE__ */ pick$1("useCallback");
const useEffect = /* @__PURE__ */ pick$1("useEffect");
const useState = /* @__PURE__ */ pick$1("useState");
const m = window.__dispatch.deps["lucide"];
const pick = (k) => m[k];
const Check = /* @__PURE__ */ pick("Check");
const Copy = /* @__PURE__ */ pick("Copy");
const KeyRound = /* @__PURE__ */ pick("KeyRound");
const Pencil = /* @__PURE__ */ pick("Pencil");
const Plus = /* @__PURE__ */ pick("Plus");
const RefreshCw = /* @__PURE__ */ pick("RefreshCw");
const Server = /* @__PURE__ */ pick("Server");
const ShieldCheck = /* @__PURE__ */ pick("ShieldCheck");
const Trash2 = /* @__PURE__ */ pick("Trash2");
function defineClientPlugin(mod) {
  return mod;
}
const KEY_LINE = 2;
const CONNECTING = "connecting";
const SETTINGS_CHANGED = "its settings changed; reconnecting";
const CONNECTION_LOST = "connection lost; reconnecting";
const RECONNECTING_WORDS = {
  [CONNECTING]: "Connecting",
  [SETTINGS_CHANGED]: "Reconnecting: its settings changed",
  [CONNECTION_LOST]: "Reconnecting: the connection was lost"
};
const POLL_MS = 5e3;
const inputCls = "w-full min-w-0 rounded-md border border-line bg-inset px-2.5 py-1.5 text-xs text-primary placeholder:text-faint focus:border-accent-line focus:outline-none disabled:opacity-60";
const monoInputCls = `${inputCls} cm-mono`;
async function call(host, path, method = "GET", body) {
  const res = await host.api.fetch(path, {
    method,
    ...body !== void 0 ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}
const errText = (err) => err instanceof Error ? err.message : String(err);
const slugPath = (slug) => `hosts/${encodeURIComponent(slug)}`;
function useHosts(host) {
  const [hosts, setHosts] = useState();
  const [error, setError] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const r = await call(host, "hosts");
      setHosts(r.hosts);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [host]);
  useEffect(() => {
    var _a;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const off = (_a = host.settings) == null ? void 0 : _a.onChange(() => void refresh());
    return () => {
      clearInterval(t);
      off == null ? void 0 : off();
    };
  }, [host, refresh]);
  return { hosts, error, refresh };
}
function RemoteHostsPage({ host }) {
  const { Button } = host.ui;
  const { hosts, error, refresh } = useHosts(host);
  const [pairing, setPairing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [elevating, setElevating] = useState(null);
  return /* @__PURE__ */ jsxs("div", { className: "space-y-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "space-y-1.5", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-xs leading-relaxed text-muted", children: [
        "Machines a chat's terminals can run on, over SSH. Each one is a terminal location,",
        " ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "remote-host/<name>" }),
        ", that a project or a chat can pick; its files sync around every command. Prepare the machine first: a dedicated account with Remote Login on (the plugin's README has the Mac walkthrough)."
      ] }),
      /* @__PURE__ */ jsx("div", { className: "flex items-center gap-2", children: /* @__PURE__ */ jsx(Button, { variant: "primary", size: "sm", leftIcon: /* @__PURE__ */ jsx(Plus, {}), onClick: () => setPairing({}), children: "Pair a machine" }) })
    ] }),
    error && /* @__PURE__ */ jsx(ErrorStrip, { message: `Couldn't read the machines: ${error}` }),
    hosts === void 0 && !error ? /* @__PURE__ */ jsx("p", { className: "text-xs text-muted", children: "Loading…" }) : hosts && hosts.length === 0 ? /* @__PURE__ */ jsx("div", { className: "rounded-md border border-line bg-inset p-3 text-xs text-muted", children: "No machines paired yet." }) : /* @__PURE__ */ jsx("div", { className: "space-y-2", children: (hosts ?? []).map((h) => /* @__PURE__ */ jsx(
      HostRow,
      {
        host,
        view: h,
        onChanged: refresh,
        onEdit: () => setEditing(h),
        onRemove: () => setRemoving(h),
        onElevation: () => setElevating(h),
        onRepair: () => setPairing({
          slug: h.slug,
          label: h.label,
          address: h.addresses[0],
          addresses: h.addresses,
          port: h.port,
          user: h.user,
          replace: true
        })
      },
      h.slug
    )) }),
    pairing && /* @__PURE__ */ jsx(
      PairDialog,
      {
        host,
        prefill: pairing,
        onClose: () => {
          setPairing(null);
          void refresh();
        }
      }
    ),
    editing && /* @__PURE__ */ jsx(
      EditDialog,
      {
        host,
        view: editing,
        onClose: () => {
          setEditing(null);
          void refresh();
        }
      }
    ),
    removing && /* @__PURE__ */ jsx(
      RemoveDialog,
      {
        host,
        view: removing,
        onClose: () => {
          setRemoving(null);
          void refresh();
        }
      }
    ),
    elevating && /* @__PURE__ */ jsx(
      ElevationDialog,
      {
        host,
        view: elevating,
        onClose: () => {
          setElevating(null);
          void refresh();
        }
      }
    )
  ] });
}
const TONE = {
  online: "bg-success",
  degraded: "bg-warn",
  offline: "bg-danger"
};
function HostRow(props) {
  var _a, _b;
  const { host, view } = props;
  const { Button, IconButton, Tooltip } = host.ui;
  const [checking, setChecking] = useState(false);
  const s = view.status;
  const connecting = reconnecting(view) !== void 0;
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
  return /* @__PURE__ */ jsx("div", { className: "rounded-md border border-line p-3", children: /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2.5", children: [
    /* @__PURE__ */ jsx(Tooltip, { label: statusWords(view), children: /* @__PURE__ */ jsx(
      "span",
      {
        "aria-label": statusWords(view),
        className: `mt-1.5 inline-block shrink-0 rounded-full ${connecting ? "bg-faint" : TONE[s.state] ?? "bg-faint"}`,
        style: { width: 8, height: 8 }
      }
    ) }),
    /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1 space-y-0.5", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-baseline gap-x-2", children: [
        /* @__PURE__ */ jsx("span", { className: "truncate text-sm font-medium text-primary", children: view.label }),
        /* @__PURE__ */ jsx("span", { className: "cm-mono truncate text-2xs text-faint", children: view.id })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "cm-mono truncate text-xs text-secondary", children: where }),
      /* @__PURE__ */ jsx("div", { className: "text-xs text-muted", children: statusLine(view) }),
      view.probe && /* @__PURE__ */ jsx("div", { className: "text-xs text-muted", children: probeLine(view) }),
      view.probe && missingTools(view).length > 0 && /* @__PURE__ */ jsxs("div", { className: "text-xs text-warn", children: [
        "Not on its PATH: ",
        missingTools(view).join(", ")
      ] }),
      (view.keyLine ?? 1) < KEY_LINE && /* @__PURE__ */ jsxs("div", { className: "text-xs text-warn", children: [
        "Paired before 0.4.0: its key lets forwarded ports reach 127.0.0.1 only. Pair again to enable IPv6 dev servers (Vite's ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "localhost" }),
        " on macOS)."
      ] }),
      view.abandoned && /* @__PURE__ */ jsxs("div", { className: "text-xs text-muted", children: [
        "Also there: ",
        /* @__PURE__ */ jsxs("span", { className: "cm-mono", children: [
          "~/.dispatch-host/",
          view.abandoned.id
        ] }),
        ", left by this Dispatch before its id changed",
        view.abandoned.contactAt ? ` (last in touch ${ago(view.abandoned.contactAt)})` : "",
        view.abandoned.running ? `, with ${view.abandoned.running} session${view.abandoned.running === 1 ? "" : "s"} still running` : "",
        ". It is never cleaned up from here, since that id may still be a live Dispatch: delete it there once you know it isn't."
      ] }),
      /* @__PURE__ */ jsx("div", { className: "cm-mono truncate text-2xs text-faint", title: "The machine's host key, pinned at pairing", children: view.hostKey }),
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-x-2 text-xs text-muted", children: [
        /* @__PURE__ */ jsx("span", { children: elevationLine(view) }),
        (((_a = view.elevation) == null ? void 0 : _a.on) || elevationOffered(view)) && /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", leftIcon: /* @__PURE__ */ jsx(ShieldCheck, {}), onClick: props.onElevation, children: ((_b = view.elevation) == null ? void 0 : _b.on) ? "Manage" : "Set up" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex shrink-0 items-center gap-0.5", children: [
      /* @__PURE__ */ jsx(IconButton, { size: "sm", tip: "Check now", "aria-label": `Check ${view.label} now`, disabled: checking, onClick: () => void check(), children: /* @__PURE__ */ jsx(RefreshCw, { className: checking ? "animate-spin" : void 0 }) }),
      /* @__PURE__ */ jsx(IconButton, { size: "sm", tip: "Rename, or change its addresses", "aria-label": `Edit ${view.label}`, onClick: props.onEdit, children: /* @__PURE__ */ jsx(Pencil, {}) }),
      /* @__PURE__ */ jsx(IconButton, { size: "sm", tip: "Pair again (a new key, or its host key changed)", "aria-label": `Pair ${view.label} again`, onClick: props.onRepair, children: /* @__PURE__ */ jsx(KeyRound, {}) }),
      /* @__PURE__ */ jsx(IconButton, { size: "sm", tip: "Remove", "aria-label": `Remove ${view.label}`, onClick: props.onRemove, children: /* @__PURE__ */ jsx(Trash2, {}) })
    ] })
  ] }) });
}
function reconnecting(v) {
  return v.status.state === "online" || !v.status.detail ? void 0 : RECONNECTING_WORDS[v.status.detail];
}
function statusWords(v) {
  const s = v.status;
  if (s.state === "online") return "Online";
  const r = reconnecting(v);
  if (r) return r;
  if (s.state === "degraded") return `Degraded${s.detail ? `: ${s.detail}` : ""}`;
  return `Offline${s.detail ? `: ${s.detail}` : ""}`;
}
function statusLine(v) {
  const s = v.status;
  const seen = s.lastSeenAt ? `last seen ${ago(s.lastSeenAt)}` : void 0;
  if (s.state === "online") return ["Online", s.detail, seen].filter(Boolean).join(" · ");
  return [statusWords(v), seen].filter(Boolean).join(" · ");
}
function rootLogin(v) {
  var _a;
  return ((_a = v.probe) == null ? void 0 : _a.uid) !== void 0 ? v.probe.uid === 0 : v.user === "root";
}
function elevationOffered(v) {
  return !rootLogin(v) && (!v.probe || v.probe.platform === "darwin");
}
function elevationLine(v) {
  const e = v.elevation;
  if (rootLogin(v)) return "Root: the login is root, so everything runs as root, with no approval asked";
  if (!(e == null ? void 0 : e.on) && !elevationOffered(v)) return "Root: off (root with approval can only be set up on a Mac so far)";
  if (!(e == null ? void 0 : e.on)) return e && !e.canAsk ? "Root: off (needs a newer Dispatch)" : "Root: off";
  return e.canAsk ? "Root: with your approval, each time" : "Root: set up, but refused: asking for approval needs a newer Dispatch";
}
function probeLine(v) {
  const p = v.probe;
  const os = [p.os.name ?? p.platform, p.os.version].filter(Boolean).join(" ");
  const disk = typeof p.freeDiskBytes === "number" ? `${Math.round(p.freeDiskBytes / 1024 ** 3)} GB free` : void 0;
  const tools = [
    p.tools.git && `git ${p.tools.git}`,
    p.tools.node && `node ${p.tools.node}`,
    p.tools.pnpm && `pnpm ${p.tools.pnpm}`,
    p.brew && (p.brew.version ?? "Homebrew")
  ].filter(Boolean).join(", ");
  return [os, p.arch, disk, tools].filter(Boolean).join(" · ");
}
function missingTools(v) {
  var _a, _b;
  const t = (_a = v.probe) == null ? void 0 : _a.tools;
  if (!t) return [];
  const sync = (_b = v.probe) == null ? void 0 : _b.syncGit;
  return ["git", "node", "pnpm"].filter((k) => !t[k] && !(k === "git" && (sync == null ? void 0 : sync.path)));
}
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1e3));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function PairDialog({ host, prefill, onClose }) {
  const { Button, Dialog, Field, Toggle } = host.ui;
  const [step, setStep] = useState({ at: "where" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [address, setAddress] = useState(prefill.address ?? "");
  const [port, setPort] = useState(String(prefill.port ?? 22));
  const [slug, setSlug] = useState(prefill.slug ?? "");
  const [label, setLabel] = useState(prefill.label ?? "");
  const [user, setUser] = useState(prefill.user ?? "dispatch");
  const [allowFrom, setAllowFrom] = useState("");
  const [matches, setMatches] = useState(false);
  const [password, setPassword] = useState("");
  const run = async (fn) => {
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
  const close = () => {
    if (step.at === "install") void call(host, "pair/cancel", "POST", { pairingId: step.started.pairingId }).catch(() => {
    });
    onClose();
  };
  const scan = () => run(async () => {
    const r = await call(host, "pair/scan", "POST", { address: address.trim(), port: port.trim() || void 0 });
    if (!slug) setSlug(suggestSlug(address));
    setAllowFrom(r.suggestedAllowFrom.join(", "));
    setMatches(false);
    setStep({ at: "confirm", scan: r });
  });
  const start = (scanned) => run(async () => {
    var _a;
    const started = await call(host, "pair/start", "POST", {
      slug: slug.trim(),
      label: label.trim() || void 0,
      address: scanned.address,
      port: scanned.port,
      user: user.trim(),
      hostKey: scanned.fingerprint,
      hostKeyType: scanned.keyType,
      allowFrom: splitList(allowFrom),
      ...((_a = prefill.addresses) == null ? void 0 : _a.length) ? { addresses: prefill.addresses } : {},
      ...prefill.replace ? { replace: true } : {}
    });
    setStep({ at: "install", scan: scanned, started });
  });
  const finish = (pairingId, withPassword) => run(async () => {
    const done = await call(host, "pair/finish", "POST", {
      pairingId,
      ...withPassword ? { password } : {}
    });
    setPassword("");
    setStep({ at: "done", done });
  });
  let body;
  let footer;
  if (step.at === "where") {
    body = /* @__PURE__ */ jsxs("div", { className: "space-y-3", children: [
      /* @__PURE__ */ jsx(Field, { label: "Address", hint: "Its host name or IP address, as this computer reaches it", children: /* @__PURE__ */ jsx(
        "input",
        {
          className: monoInputCls,
          value: address,
          autoFocus: true,
          placeholder: "10.0.4.5",
          onChange: (e) => setAddress(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && address.trim() && void scan()
        }
      ) }),
      /* @__PURE__ */ jsx(Field, { label: "SSH port", children: /* @__PURE__ */ jsx("input", { className: monoInputCls, style: { width: 96 }, value: port, inputMode: "numeric", onChange: (e) => setPort(e.target.value) }) }),
      /* @__PURE__ */ jsx("p", { className: "text-xs leading-relaxed text-muted", children: "Next, Dispatch reads the key the machine identifies itself with. It logs in to nothing and sends nothing." })
    ] });
    footer = /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: close, children: "Cancel" }),
      /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy || !address.trim(), onClick: () => void scan(), children: busy ? "Looking…" : "Look up its host key" })
    ] });
  } else if (step.at === "confirm") {
    const s = step.scan;
    const keyFile = `/etc/ssh/ssh_host_${keyFileName(s.keyType)}_key.pub`;
    body = /* @__PURE__ */ jsxs("div", { className: "space-y-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "rounded-md border border-accent-line bg-accent-ghost/40 p-3", children: [
        /* @__PURE__ */ jsxs("p", { className: "text-xs text-secondary", children: [
          /* @__PURE__ */ jsx("span", { className: "cm-mono", children: s.address }),
          " presents this ",
          s.keyType,
          " host key:"
        ] }),
        /* @__PURE__ */ jsx("p", { className: "cm-mono mt-1 text-sm text-primary", style: { wordBreak: "break-all" }, children: s.fingerprint }),
        /* @__PURE__ */ jsxs("p", { className: "mt-2 text-xs leading-relaxed text-muted", children: [
          "On the machine itself, run ",
          /* @__PURE__ */ jsxs("span", { className: "cm-mono text-secondary", children: [
            "ssh-keygen -lf ",
            keyFile
          ] }),
          " and compare. If they differ, something between here and there is answering in its place: stop."
        ] })
      ] }),
      /* @__PURE__ */ jsx(Toggle, { checked: matches, onChange: setMatches, label: "It matches what the machine shows" }),
      /* @__PURE__ */ jsx(Field, { label: "Name", hint: /* @__PURE__ */ jsxs(Fragment, { children: [
        "The location's id, remote-host/",
        slug.trim() || "<name>",
        ". Lowercase letters, digits and dashes; fixed once paired."
      ] }), required: true, children: /* @__PURE__ */ jsx("input", { className: monoInputCls, value: slug, disabled: prefill.replace, onChange: (e) => setSlug(e.target.value.toLowerCase()) }) }),
      /* @__PURE__ */ jsx(Field, { label: "Label", hint: "What Dispatch shows; rename it any time", children: /* @__PURE__ */ jsx("input", { className: inputCls, value: label, placeholder: slug || "CVX Mac", onChange: (e) => setLabel(e.target.value) }) }),
      /* @__PURE__ */ jsx(Field, { label: "Account", hint: "The dedicated account on the machine, not your own", required: true, children: /* @__PURE__ */ jsx("input", { className: monoInputCls, value: user, onChange: (e) => setUser(e.target.value) }) }),
      /* @__PURE__ */ jsx(Field, { label: "Allowed from", hint: "This computer's addresses as the machine sees them. The key works only from these (comma-separated).", required: true, children: /* @__PURE__ */ jsx("input", { className: monoInputCls, value: allowFrom, onChange: (e) => setAllowFrom(e.target.value) }) })
    ] });
    footer = /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: () => setStep({ at: "where" }), children: "Back" }),
      /* @__PURE__ */ jsx(
        Button,
        {
          size: "sm",
          variant: "primary",
          leftIcon: /* @__PURE__ */ jsx(ShieldCheck, {}),
          disabled: busy || !matches || !slug.trim() || !user.trim() || !allowFrom.trim(),
          onClick: () => void start(s),
          children: busy ? "Making its key…" : "Trust it and continue"
        }
      )
    ] });
  } else if (step.at === "install") {
    const { started } = step;
    body = /* @__PURE__ */ jsxs("div", { className: "space-y-4", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-xs leading-relaxed text-muted", children: [
        "Dispatch made a key for this machine. Put it in ",
        /* @__PURE__ */ jsxs("span", { className: "cm-mono", children: [
          "~",
          user,
          "/.ssh/authorized_keys"
        ] }),
        " there, one of two ways. It only lets this computer run Dispatch's sessions, from the addresses you allowed."
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ jsxs(SectionTitle, { children: [
          "Run this on the machine, logged in as ",
          user
        ] }),
        /* @__PURE__ */ jsx(CopyBox, { host, text: started.oneLiner }),
        /* @__PURE__ */ jsx("div", { className: "flex justify-end", children: /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => void finish(started.pairingId, false), children: busy && !password ? "Checking…" : "I ran it, finish" }) })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ jsxs(SectionTitle, { children: [
          "Or give ",
          user,
          "'s password once"
        ] }),
        /* @__PURE__ */ jsx("p", { className: "text-xs leading-relaxed text-muted", children: "Sent only to the machine presenting the key you confirmed, used to add the line, and never stored." }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              className: inputCls,
              type: "password",
              autoComplete: "off",
              value: password,
              placeholder: "password",
              onChange: (e) => setPassword(e.target.value),
              onKeyDown: (e) => e.key === "Enter" && password && void finish(started.pairingId, true)
            }
          ),
          /* @__PURE__ */ jsx(Button, { size: "sm", disabled: busy || !password, onClick: () => void finish(started.pairingId, true), children: busy && password ? "Adding…" : "Use the password" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "text-2xs text-faint", children: [
        "This pairing expires at ",
        new Date(started.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        "."
      ] })
    ] });
    footer = /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: close, children: "Cancel" });
  } else {
    const { done } = step;
    body = /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-sm text-primary", children: [
        "Paired ",
        /* @__PURE__ */ jsx("span", { className: "font-medium", children: done.host.label }),
        " as",
        " ",
        /* @__PURE__ */ jsxs("span", { className: "cm-mono", children: [
          "remote-host/",
          done.host.slug
        ] }),
        "."
      ] }),
      /* @__PURE__ */ jsx("p", { className: "text-xs leading-relaxed text-muted", children: "It connects now and installs dispatch-host there; its status shows in the list. Pick it as a terminal location in a project's settings, or for one chat." }),
      done.seenFrom && /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted", children: [
        "It saw this computer as ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: done.seenFrom }),
        "."
      ] }),
      done.oldKey === "removed" && /* @__PURE__ */ jsx("p", { className: "text-xs text-muted", children: "The old key was taken off the machine." }),
      done.oldKey === "left" && /* @__PURE__ */ jsxs("p", { className: "text-xs text-warn", children: [
        "The old key couldn't be taken off the machine. Delete its line from ~",
        done.host.user,
        "/.ssh/authorized_keys there."
      ] })
    ] });
    footer = /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", onClick: onClose, children: "Done" });
  }
  return /* @__PURE__ */ jsx(
    Dialog,
    {
      open: true,
      onClose: close,
      icon: /* @__PURE__ */ jsx(Server, {}),
      title: prefill.replace ? `Pair ${prefill.label ?? prefill.slug} again` : "Pair a machine",
      description: STEP_TEXT[step.at],
      width: 520,
      footer: /* @__PURE__ */ jsx("div", { className: "flex w-full items-center justify-end gap-2", children: footer }),
      children: /* @__PURE__ */ jsxs("div", { className: "space-y-3", children: [
        body,
        /* @__PURE__ */ jsx(ErrorStrip, { message: error })
      ] })
    }
  );
}
const STEP_TEXT = {
  where: "Step 1 of 3: where it is",
  confirm: "Step 2 of 3: is it really that machine?",
  install: "Step 3 of 3: let this computer in",
  done: "Done"
};
function keyFileName(type) {
  if (type === "ssh-ed25519") return "ed25519";
  if (type.startsWith("ecdsa")) return "ecdsa";
  if (type === "ssh-rsa" || type.startsWith("rsa")) return "rsa";
  return "ed25519";
}
function suggestSlug(address) {
  const a = address.trim().toLowerCase();
  if (!a || /^[0-9.]+$/.test(a) || a.includes(":")) return "";
  return (a.split(".")[0] ?? "").replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 48);
}
function splitList(s) {
  return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}
function EditDialog({ host, view, onClose }) {
  const { Button, Dialog, Field } = host.ui;
  const [label, setLabel] = useState(view.label);
  const [addresses, setAddresses] = useState(view.addresses.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
  return /* @__PURE__ */ jsx(
    Dialog,
    {
      open: true,
      onClose,
      icon: /* @__PURE__ */ jsx(Pencil, {}),
      title: `Edit ${view.label}`,
      description: /* @__PURE__ */ jsx("span", { className: "cm-mono", children: view.id }),
      width: 460,
      footer: /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-end gap-2", children: [
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: onClose, children: "Cancel" }),
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy || !label.trim() || !addresses.trim(), onClick: () => void save(), children: "Save" })
      ] }),
      children: /* @__PURE__ */ jsxs("div", { className: "space-y-3", children: [
        /* @__PURE__ */ jsx(Field, { label: "Label", hint: `Its name stays ${view.id}, so chats and projects keep pointing at it`, children: /* @__PURE__ */ jsx("input", { className: inputCls, value: label, autoFocus: true, onChange: (e) => setLabel(e.target.value) }) }),
        /* @__PURE__ */ jsx(Field, { label: "Addresses", hint: "Tried in order, comma-separated. Its pinned host key decides which one is really it.", children: /* @__PURE__ */ jsx("input", { className: monoInputCls, value: addresses, onChange: (e) => setAddresses(e.target.value) }) }),
        /* @__PURE__ */ jsx(ErrorStrip, { message: error })
      ] })
    }
  );
}
function RemoveDialog({ host, view, onClose }) {
  var _a;
  const { Button, Dialog } = host.ui;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call(host, slugPath(view.slug), "DELETE");
      if (r.note) host.toast(`Removed ${view.label}, but something of it is left on the machine`, { kind: "warn", detail: r.note });
      else host.toast(`Removed ${view.label}`, { kind: "info" });
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx(
    Dialog,
    {
      open: true,
      onClose,
      icon: /* @__PURE__ */ jsx(Trash2, {}),
      title: `Remove ${view.label}?`,
      width: 460,
      footer: /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-end gap-2", children: [
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: onClose, children: "Keep it" }),
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "danger", disabled: busy, onClick: () => void remove(), children: busy ? "Removing…" : "Remove" })
      ] }),
      children: /* @__PURE__ */ jsxs("div", { className: "space-y-2 text-xs leading-relaxed text-muted", children: [
        /* @__PURE__ */ jsxs("p", { children: [
          "This ends this Dispatch's terminals on it, takes this computer's key out of",
          " ",
          /* @__PURE__ */ jsxs("span", { className: "cm-mono", children: [
            "~",
            view.user,
            "/.ssh/authorized_keys"
          ] }),
          " there, and deletes the key here. Chats and projects that run terminals on ",
          /* @__PURE__ */ jsx("span", { className: "cm-mono", children: view.id }),
          " are refused until you pick another location."
        ] }),
        ((_a = view.elevation) == null ? void 0 : _a.on) && /* @__PURE__ */ jsx("p", { children: "Root with approval is turned off first: its hidden account, helper and sudoers rule come out of the machine, and its key is deleted here." }),
        /* @__PURE__ */ jsx("p", { children: "Files under ~/.dispatch-host on the machine stay; delete them there if you want them gone." }),
        /* @__PURE__ */ jsx(ErrorStrip, { message: error })
      ] })
    }
  );
}
function ElevationDialog({ host, view, onClose }) {
  var _a, _b;
  const { Button, Dialog } = host.ui;
  const on = ((_a = view.elevation) == null ? void 0 : _a.on) === true;
  const canAsk = ((_b = view.elevation) == null ? void 0 : _b.canAsk) === true;
  const [start, setStart] = useState(null);
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState(null);
  const [outdated, setOutdated] = useState(null);
  const base = `${slugPath(view.slug)}/elevation`;
  const act = async (what, fn) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };
  const makeCommand = () => act("setup", async () => setStart(await call(host, `${base}/setup`, "POST")));
  const verify = () => act("verify", async () => {
    const r = await call(host, `${base}/verify`, "POST");
    if (r.outdated && r.current) {
      setStart(null);
      setOutdated({ version: r.version, current: r.current });
      return;
    }
    host.toast(on ? `${view.label}: root with approval works (helper ${r.version})` : `Root with approval is on for ${view.label}`, {
      kind: "info"
    });
    onClose();
  });
  const turnOff = () => act("off", async () => {
    const r = await call(host, base, "DELETE");
    if (r.manual) {
      setManual(r);
      return;
    }
    host.toast(`Root with approval is off for ${view.label}`, { kind: "info" });
    onClose();
  });
  const isOn = on || outdated !== null;
  const footer = manual ? /* @__PURE__ */ jsx("div", { className: "flex w-full items-center justify-end gap-2", children: /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", onClick: onClose, children: "Done" }) }) : isOn && !start ? /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-end gap-2", children: [
    /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: onClose, children: "Close" }),
    outdated && /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy !== null, onClick: () => void makeCommand(), children: busy === "setup" ? "Making it…" : "Update the helper" }),
    /* @__PURE__ */ jsx(Button, { size: "sm", disabled: busy !== null, onClick: () => void verify(), children: busy === "verify" ? "Checking…" : "Check it" }),
    /* @__PURE__ */ jsx(Button, { size: "sm", variant: "danger", disabled: busy !== null, onClick: () => void turnOff(), children: busy === "off" ? "Turning off…" : "Turn off" })
  ] }) : /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-end gap-2", children: [
    /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: onClose, children: "Cancel" }),
    start ? /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy !== null, onClick: () => void verify(), children: busy === "verify" ? "Verifying…" : "Verify" }) : /* @__PURE__ */ jsx(Button, { size: "sm", variant: "primary", disabled: busy !== null, onClick: () => void makeCommand(), children: busy === "setup" ? "Making it…" : "Make the setup command" })
  ] });
  return /* @__PURE__ */ jsx(
    Dialog,
    {
      open: true,
      onClose,
      icon: /* @__PURE__ */ jsx(ShieldCheck, {}),
      title: `Root with approval on ${view.label}`,
      description: /* @__PURE__ */ jsx("span", { className: "cm-mono", children: view.id }),
      width: 560,
      footer,
      children: /* @__PURE__ */ jsxs("div", { className: "space-y-3 text-xs leading-relaxed text-muted", children: [
        manual ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("p", { children: [
            "It is off here: its key is deleted, so nothing can use it. But it couldn't be taken out of ",
            view.label,
            " itself (",
            manual.detail ?? manual.there,
            "). To remove the hidden account, the helper and its sudoers rule, run this there as an administrator:"
          ] }),
          /* @__PURE__ */ jsx(CopyBox, { host, text: manual.manual })
        ] }) : isOn && !start ? /* @__PURE__ */ jsxs(Fragment, { children: [
          outdated && /* @__PURE__ */ jsxs(WarnStrip, { children: [
            "The helper on ",
            view.label,
            " is version ",
            outdated.version,
            "; this plugin brings version ",
            outdated.current,
            ". It still works. To update it, press ",
            /* @__PURE__ */ jsx("b", { children: "Update the helper" }),
            " and run the command there again: it keeps the same key, so nothing stops working meanwhile."
          ] }),
          /* @__PURE__ */ jsxs("p", { children: [
            "On. A command in a chat's terminal on ",
            view.label,
            " that asks for root (",
            /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "sudo …" }),
            " or",
            " ",
            /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "dispatch-elevate …" }),
            ") waits for you to approve that exact command in its chat, then runs once, as root, over a login only this Dispatch holds the key to."
          ] }),
          !canAsk && /* @__PURE__ */ jsx(WarnStrip, { children: "This Dispatch can't ask you for approval yet (it needs a newer Dispatch), so such commands are refused until it can." }),
          /* @__PURE__ */ jsxs("p", { children: [
            /* @__PURE__ */ jsx("b", { children: "Check it" }),
            " logs in and has the helper prove it runs as root. ",
            /* @__PURE__ */ jsx("b", { children: "Turn off" }),
            " removes the hidden account, the helper and its sudoers rule from the machine, and deletes the key here. The helper's log, ",
            /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "/var/log/dispatch-elevate.log" }),
            ", stays."
          ] })
        ] }) : !start ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("p", { children: [
            "Lets a chat run a command as root on ",
            view.label,
            ", each time only after you approve that exact command in the chat. The agent's own account there gets no password and no sudo rights. Instead, a one-time setup adds:"
          ] }),
          /* @__PURE__ */ jsxs("ul", { className: "list-disc space-y-0.5 pl-5", children: [
            /* @__PURE__ */ jsxs("li", { children: [
              "a hidden account, ",
              /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "_dispatchelevate" }),
              ", with no password, which can log in only with a key this Dispatch holds, only from this computer's addresses, and only to run the helper;"
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              "the helper, root-owned at ",
              /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "/usr/local/libexec/dispatch-elevate" }),
              ", which logs every command;"
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              "a sudoers rule letting that account, and nobody else, run the helper as root (checked with",
              " ",
              /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "visudo" }),
              " first)."
            ] })
          ] }),
          !canAsk && /* @__PURE__ */ jsx(WarnStrip, { children: "This Dispatch can't ask you for approval yet (it needs a newer Dispatch): until it can, root commands stay refused even once this is set up." })
        ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("p", { children: [
            "Run this at ",
            view.label,
            ", in Terminal, as an administrator (it asks for your password), then press ",
            /* @__PURE__ */ jsx("b", { children: "Verify" }),
            ". Running it again is safe."
          ] }),
          /* @__PURE__ */ jsx(CopyBox, { host, text: start.oneLiner }),
          /* @__PURE__ */ jsxs("p", { children: [
            "Its key is accepted only from ",
            /* @__PURE__ */ jsx("span", { className: "cm-mono", children: start.allowFrom.join(", ") }),
            " (this computer, as paired). The command is good for 2 hours; after that, make a new one."
          ] }),
          /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: () => setShowScript((s) => !s), children: showScript ? "Hide what it runs" : "Show what it runs" }),
          showScript && /* @__PURE__ */ jsx(
            "pre",
            {
              className: "cm-mono rounded-md border border-line bg-inset p-3 text-2xs text-secondary",
              style: { maxHeight: 280, overflow: "auto", whiteSpace: "pre" },
              children: start.script
            }
          )
        ] }),
        /* @__PURE__ */ jsx(ErrorStrip, { message: error })
      ] })
    }
  );
}
function CopyBox({ host, text }) {
  const { Button } = host.ui;
  const [copied, setCopied] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2", children: [
    /* @__PURE__ */ jsx(
      "textarea",
      {
        className: `${monoInputCls} resize-none`,
        readOnly: true,
        rows: 3,
        value: text,
        onFocus: (e) => e.currentTarget.select()
      }
    ),
    /* @__PURE__ */ jsx(
      Button,
      {
        size: "sm",
        leftIcon: copied ? /* @__PURE__ */ jsx(Check, {}) : /* @__PURE__ */ jsx(Copy, {}),
        onClick: () => {
          var _a;
          void ((_a = navigator.clipboard) == null ? void 0 : _a.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2e3);
          }));
        },
        children: copied ? "Copied" : "Copy"
      }
    )
  ] });
}
function SectionTitle({ children }) {
  return /* @__PURE__ */ jsx("div", { className: "text-2xs font-semibold uppercase tracking-[0.09em] text-faint", children });
}
function WarnStrip({ children }) {
  return /* @__PURE__ */ jsx("div", { className: "rounded-md border border-line bg-inset px-2.5 py-1.5 text-xs text-warn", children });
}
function ErrorStrip({ message }) {
  if (!message) return null;
  return /* @__PURE__ */ jsx("div", { role: "alert", className: "rounded-md border border-danger/30 bg-danger-ghost px-2.5 py-1.5 text-xs text-danger", children: message });
}
const client = defineClientPlugin({
  activate(host) {
    host.slots.settingsSection({
      id: "hosts",
      label: "Remote hosts",
      blurb: "Machines chat terminals can run on",
      icon: Server,
      render: () => /* @__PURE__ */ jsx(RemoteHostsPage, { host })
    });
  }
});
export {
  client as default
};
