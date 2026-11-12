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
const Box = /* @__PURE__ */ pick("Box");
const RefreshCw = /* @__PURE__ */ pick("RefreshCw");
const SkipForward = /* @__PURE__ */ pick("SkipForward");
const Trash2 = /* @__PURE__ */ pick("Trash2");
function defineClientPlugin(mod) {
  return mod;
}
const POLL_MS = 1e4;
async function call(host, path, method = "GET") {
  const res = await host.api.fetch(path, { method });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}
const errText = (err) => err instanceof Error ? err.message : String(err);
const legacyPath = (chatId, action) => `legacy/${encodeURIComponent(chatId)}/${action}`;
function useOverview(host) {
  const [view, setView] = useState();
  const [error, setError] = useState(null);
  const refresh = useCallback(async () => {
    try {
      setView(await call(host, "overview"));
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
  return { view, error, refresh };
}
const TONE = { online: "bg-success", offline: "bg-danger" };
function ContainersPage({ host }) {
  const { Button } = host.ui;
  const { view, error, refresh } = useOverview(host);
  const [acting, setActing] = useState(null);
  return /* @__PURE__ */ jsxs("div", { className: "space-y-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "space-y-1.5", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-xs leading-relaxed text-muted", children: [
        "Each chat that runs terminals on ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "proxmox" }),
        " gets its own container, a linked clone of the template, run through Remote host. The settings are under Plugins → Proxmox terminal."
      ] }),
      /* @__PURE__ */ jsx(Button, { size: "sm", leftIcon: /* @__PURE__ */ jsx(RefreshCw, {}), onClick: () => void refresh(), children: "Refresh" })
    ] }),
    /* @__PURE__ */ jsx(ErrorStrip, { message: error ? `Couldn't read the containers: ${error}` : null }),
    view === void 0 && !error && /* @__PURE__ */ jsx("p", { className: "text-xs text-muted", children: "Loading…" }),
    view && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 text-xs", children: [
        /* @__PURE__ */ jsx("span", { className: `inline-block h-2 w-2 rounded-full ${TONE[view.status.state] ?? "bg-warn"}` }),
        /* @__PURE__ */ jsx("span", { className: "text-primary", children: view.status.state === "online" ? "Terminals can run" : "Terminals are refused" }),
        view.status.detail && /* @__PURE__ */ jsxs("span", { className: "text-muted", children: [
          "— ",
          view.status.detail
        ] })
      ] }),
      !view.hostKeyPinned && /* @__PURE__ */ jsxs(WarnStrip, { children: [
        "The template's host key isn't pinned, so a container is trusted because the Proxmox API gave its address, and remote-host says so on every connect. Set ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "templateHostKey" }),
        " to the template's ED25519 fingerprint (",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" }),
        " on it)."
      ] }),
      view.range.warn && /* @__PURE__ */ jsxs(WarnStrip, { children: [
        view.range.used,
        " of the ",
        view.range.size,
        " vmids in ",
        view.range.start,
        "–",
        view.range.end,
        " are taken. Delete chats you are done with, or widen the range, before new chats can't get a container."
      ] }),
      view.apiError && /* @__PURE__ */ jsxs(WarnStrip, { children: [
        "The Proxmox API didn't answer: ",
        view.apiError
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
        /* @__PURE__ */ jsx(SectionTitle, { children: "Containers from before 0.2" }),
        view.legacy.length === 0 ? /* @__PURE__ */ jsx("div", { className: "rounded-md border border-line bg-inset p-3 text-xs text-muted", children: "None waiting." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("p", { className: "text-xs leading-relaxed text-muted", children: [
            view.legacy.length,
            " legacy container",
            view.legacy.length === 1 ? "" : "s",
            " waiting for ",
            view.legacy.length === 1 ? "its chat" : "their chats",
            ". At a chat's next command, its old checkout's unsaved work is saved into a git ref in the chat's repository, then the chat carries on. Until then each one stays stopped and is never destroyed for being unused. Uninstalling this plugin destroys ",
            view.legacy.length === 1 ? "it" : "them",
            " unrescued."
          ] }),
          view.legacy.map((row) => /* @__PURE__ */ jsx(LegacyRow, { host, row, onAct: (action) => setActing({ row, action }) }, row.chatId))
        ] })
      ] })
    ] }),
    acting && /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        host,
        row: acting.row,
        action: acting.action,
        onClose: () => {
          setActing(null);
          void refresh();
        }
      }
    )
  ] });
}
function LegacyRow({ host, row, onAct }) {
  const { Button } = host.ui;
  const state = row.rescuing ? `rescuing${row.phase ? ` (${row.phase})` : ""}` : row.failures ? `rescue failed ${row.failures}×` : "waiting";
  return /* @__PURE__ */ jsxs("div", { className: "space-y-1.5 rounded-md border border-line bg-inset p-2.5 text-xs", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx(Box, { className: "h-3.5 w-3.5 text-faint" }),
      /* @__PURE__ */ jsx("span", { className: "cm-mono text-primary", children: row.vmid }),
      /* @__PURE__ */ jsx("span", { className: "cm-mono text-muted", children: row.hostname }),
      row.status && /* @__PURE__ */ jsx("span", { className: "text-faint", children: row.status }),
      /* @__PURE__ */ jsxs("span", { className: "text-muted", children: [
        "· chat ",
        /* @__PURE__ */ jsx("span", { className: "cm-mono", children: row.chatId }),
        " · ",
        state
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "ml-auto flex items-center gap-2", children: [
        row.canSkip && /* @__PURE__ */ jsx(Button, { size: "sm", leftIcon: /* @__PURE__ */ jsx(SkipForward, {}), disabled: row.rescuing, onClick: () => onAct("skip"), children: "Skip rescue" }),
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "danger", leftIcon: /* @__PURE__ */ jsx(Trash2, {}), disabled: row.rescuing, onClick: () => onAct("destroy"), children: "Destroy without rescue" })
      ] })
    ] }),
    row.lastError && /* @__PURE__ */ jsxs("div", { className: "text-warn", children: [
      "Last attempt: ",
      row.lastError
    ] })
  ] });
}
function ConfirmDialog(props) {
  const { host, row, action, onClose } = props;
  const { Button, Dialog } = host.ui;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
  return /* @__PURE__ */ jsx(
    Dialog,
    {
      open: true,
      onClose,
      icon: destroy ? /* @__PURE__ */ jsx(Trash2, {}) : /* @__PURE__ */ jsx(SkipForward, {}),
      title: destroy ? `Destroy container ${row.vmid} without rescue?` : `Skip the rescue of container ${row.vmid}?`,
      width: 460,
      footer: /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-end gap-2", children: [
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: "ghost", onClick: onClose, children: "Cancel" }),
        /* @__PURE__ */ jsx(Button, { size: "sm", variant: destroy ? "danger" : "primary", disabled: busy, onClick: () => void go(), children: busy ? "Working…" : destroy ? "Destroy" : "Skip rescue" })
      ] }),
      children: /* @__PURE__ */ jsxs("div", { className: "space-y-2 text-xs leading-relaxed text-muted", children: [
        destroy ? /* @__PURE__ */ jsxs("p", { children: [
          "The container and everything on it go now, including any edits in its old checkout that never came back to this computer. Chat ",
          /* @__PURE__ */ jsx("span", { className: "cm-mono", children: row.chatId }),
          "'s next command gets a new container."
        ] }) : /* @__PURE__ */ jsxs("p", { children: [
          "Chat ",
          /* @__PURE__ */ jsx("span", { className: "cm-mono", children: row.chatId }),
          "'s next command goes ahead on this container without saving its old checkout first. The old checkout stays on the container until the container is destroyed, and from now on it can be destroyed for being unused, like any other."
        ] }),
        /* @__PURE__ */ jsx(ErrorStrip, { message: error })
      ] })
    }
  );
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
      id: "containers",
      label: "Proxmox containers",
      blurb: "Per-chat terminal containers",
      icon: Box,
      render: () => /* @__PURE__ */ jsx(ContainersPage, { host })
    });
  }
});
export {
  client as default
};
