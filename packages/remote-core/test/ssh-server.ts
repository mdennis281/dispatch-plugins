/**
 * An SSH server in the test process (ssh2's Server, pure JS, so it runs on
 * Windows too). It records every authentication attempt, so a test can prove
 * what a client did NOT send — a password to a host whose key didn't match —
 * and answers exec requests however the test says.
 *
 * Exported to other packages' tests as `@dispatch-plugins/remote-core/testing`.
 */
import { spawn } from "node:child_process";
import { connect, type AddressInfo } from "node:net";
import { Server, utils, type AuthContext, type ServerChannel } from "ssh2";
import { hostKeyFingerprint } from "../src/ssh/host-verifier.js";
import { generateKeyPair } from "../src/ssh/keys.js";

export interface AuthAttempt {
  method: string;
  username: string;
  /** Only for `password` and `keyboard-interactive`. */
  password?: string;
  /** For `publickey`: the key's base64 blob. */
  key?: string;
}

export interface ExecRequest {
  command: string;
  channel: ServerChannel;
  username: string;
}

export interface TestSshServerOptions {
  /** The password to accept, by `password` or `keyboard-interactive`. */
  password?: string;
  /** Accept passwords only through keyboard-interactive, as macOS's PAM setup often does. */
  keyboardInteractiveOnly?: boolean;
  /** Public keys (`type base64 …` lines or bare base64 blobs) to accept. Read at each attempt. */
  authorizedKeys?: () => readonly string[];
  /** Answer one exec. Default: exit 0, no output. */
  exec?: (req: ExecRequest) => void;
  /** Allow `direct-tcpip` (local forwards) to the loopback, 127.0.0.1 or ::1, as remote-host's `permitopen` does. Default true. */
  allowForwards?: boolean;
  /** Refuse a session past this many open at once on one connection, like sshd's `MaxSessions` (10). Default: no limit. */
  maxSessions?: number;
}

export interface TestSshServer {
  host: string;
  port: number;
  /** The host key's `SHA256:` fingerprint and type, as a client sees them. */
  fingerprint: string;
  keyType: string;
  attempts: AuthAttempt[];
  execs: string[];
  /** End every client connection (a dropped network), leaving the server listening. */
  dropClients(): void;
  close(): Promise<void>;
}

export async function startTestSshServer(opts: TestSshServerOptions = {}): Promise<TestSshServer> {
  // Not ssh2's generateKeyPairSync: one key in 256 it makes is malformed (see keys.ts).
  const hostKey = { private: generateKeyPair("test-host").privateKey };
  const parsed = utils.parseKey(hostKey.private);
  if (parsed instanceof Error) throw parsed;
  const attempts: AuthAttempt[] = [];
  const execs: string[] = [];
  const clients = new Set<{ end(): void }>();

  const accepts = (b64: string) =>
    (opts.authorizedKeys?.() ?? []).some((line) => line === b64 || line.split(/\s+/).includes(b64));

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    let username = "";
    client.on("authentication", (ctx: AuthContext) => {
      username = ctx.username;
      const methods: Array<"password" | "publickey" | "keyboard-interactive"> = ["publickey"];
      if (opts.password) methods.push(opts.keyboardInteractiveOnly ? "keyboard-interactive" : "password");
      switch (ctx.method) {
        case "password":
          attempts.push({ method: "password", username: ctx.username, password: ctx.password });
          if (!opts.keyboardInteractiveOnly && opts.password && ctx.password === opts.password) return ctx.accept();
          return ctx.reject(methods);
        case "keyboard-interactive":
          if (!opts.password) {
            attempts.push({ method: "keyboard-interactive", username: ctx.username });
            return ctx.reject(methods);
          }
          return ctx.prompt([{ prompt: "Password:", echo: false }], (answers) => {
            attempts.push({ method: "keyboard-interactive", username: ctx.username, password: answers[0] });
            if (answers[0] === opts.password) ctx.accept();
            else ctx.reject(methods);
          });
        case "publickey": {
          const b64 = ctx.key.data.toString("base64");
          attempts.push({ method: "publickey", username: ctx.username, key: b64 });
          if (!accepts(b64)) return ctx.reject(methods);
          if (!ctx.signature) return ctx.accept(); // "this key would do; sign with it"
          const pub = utils.parseKey(`${ctx.key.algo} ${b64}`);
          if (pub instanceof Error || !ctx.blob) return ctx.reject(methods);
          return pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject(methods);
        }
        default:
          attempts.push({ method: ctx.method, username: ctx.username });
          return ctx.reject(methods);
      }
    });
    let sessions = 0;
    client.on("ready", () => {
      client.on("session", (acceptSession, rejectSession) => {
        if (opts.maxSessions !== undefined && sessions >= opts.maxSessions) return rejectSession();
        sessions++;
        const session = acceptSession();
        session.once("close", () => sessions--);
        session.on("exec", (accept, _reject, info) => {
          const channel = accept();
          execs.push(info.command);
          if (opts.exec) opts.exec({ command: info.command, channel, username });
          else {
            channel.exit(0);
            channel.end();
          }
        });
      });
      client.on("tcpip", (accept, reject, info) => {
        if (opts.allowForwards === false || (info.destIP !== "127.0.0.1" && info.destIP !== "::1")) return reject();
        const sock = connect(info.destPort, info.destIP);
        sock.on("error", () => reject());
        sock.once("connect", () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
          ch.on("close", () => sock.destroy());
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    host: "127.0.0.1",
    port,
    fingerprint: hostKeyFingerprint(parsed.getPublicSSH()),
    keyType: parsed.type,
    attempts,
    execs,
    dropClients: () => {
      for (const c of clients) c.end();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}

/**
 * An exec handler that RUNS the command, as sshd would: `/bin/sh -c <command>`
 * with `env`, its stdio wired to the channel. POSIX only.
 */
export function runLocally(env: NodeJS.ProcessEnv): (req: ExecRequest) => void {
  return ({ command, channel }) => {
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    channel.pipe(child.stdin);
    child.stdin.on("error", () => {});
    channel.on("error", () => {});
    // The client went away (a dropped connection): sshd hangs up on the command.
    channel.on("close", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGHUP");
    });
    let outDone = false;
    let errDone = false;
    let code: number | null = null;
    const end = () => {
      if (!outDone || !errDone || code === null) return;
      try {
        channel.exit(code);
        channel.end();
      } catch {
        /* the client already closed it */
      }
    };
    child.stdout.on("end", () => ((outDone = true), end()));
    child.stderr.on("end", () => ((errDone = true), end()));
    child.on("exit", (c, sig) => ((code = c ?? (sig ? 128 : 1)), end()));
  };
}
