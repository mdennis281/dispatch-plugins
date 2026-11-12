# @dispatch-plugins/remote-host-api

The types of remote-host's `machines@1` export, for a plugin that provisions
machines (a container per chat) and has remote-host run what happens on them:
shells, the synced checkout, forwarded ports, MCP servers, the agent's tools.

Types and one inert constant, `MACHINES`. Depend on it as a `workspace:*`
devDependency and import it with `import type`: the export itself comes from
core's plugin dependencies at run time, never from this package.

```yaml
# the caller's plugin.yaml
dependencies:
  remote-host:
    uses: [machines@1]
```

```ts
import type { MachinesV1 } from "@dispatch-plugins/remote-host-api";
const machines = ctx.dependencies?.get<MachinesV1>("remote-host", "machines", 1);
```

What each member promises is documented in `src/index.ts`; how remote-host
keeps it is in `plugins/remote-host/README.md` ("Machines for other plugins").
