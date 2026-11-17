import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import type { JSX } from "solid-js"

import type { IpcClient, SetupContext } from "@opencode/plugin/gui"
import type { Kind, Market } from "../contract"
import type { Item } from "../contract"

type Tab = Kind | "installed"

const KINDS: { kind: Kind; label: string; icon: "extensions" | "mcp" | "graduation-cap" }[] = [
  { kind: "plugin", label: "Plugins", icon: "extensions" },
  { kind: "mcp", label: "MCP servers", icon: "mcp" },
  { kind: "skill", label: "Skills", icon: "graduation-cap" },
]

const MUTED: JSX.CSSProperties = { color: "var(--text-weak, #888)" }
const ROW: JSX.CSSProperties = { display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }
const BAR: JSX.CSSProperties = { display: "flex", gap: "8px", "align-items": "center", "margin-bottom": "12px", "flex-wrap": "wrap" }

export function MarketPage(props: { ctx: SetupContext<{}>; admin: IpcClient<typeof Market.spec> }) {
  const [kind, setKind] = createSignal<Kind>("plugin")
  const [draft, setDraft] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const [needsReload, setNeedsReload] = createSignal(false)
  const [reloading, setReloading] = createSignal(false)
  const [note, setNote] = createSignal("")

  const [result, { refetch: refetchCatalog }] = createResource(
    () => ({ kind: kind(), query: query() }),
    (input) => props.admin.catalog({ kind: input.kind, query: input.query, force: false }),
  )
  const [state, { refetch: refetchState }] = createResource(() => props.admin.installed())

  const isInstalled = (item: Item): boolean => {
    const current = state()
    if (!current) return item.installed
    if (item.kind === "plugin") return current.plugins.some((plugin) => plugin.name === item.name)
    if (item.kind === "mcp")
      return current.mcps.some(
        (mcp) => (item.url !== undefined && mcp.detail === item.url) || (item.command !== undefined && mcp.detail === item.command.join(" ")),
      )
    return current.skills.some((skill) => skill.name === item.name)
  }

  const visible = createMemo(() => {
    const text = draft().trim().toLowerCase()
    const items = result()?.items ?? []
    if (text.length === 0) return items
    return items.filter((item) => `${item.title} ${item.name} ${item.description}`.toLowerCase().includes(text))
  })

  const installedRows = createMemo(() => {
    const current = state()
    if (!current) return []
    if (kind() === "plugin") return current.plugins.map((plugin) => ({ key: plugin.name, title: plugin.name, detail: plugin.spec }))
    if (kind() === "mcp") return current.mcps.map((mcp) => ({ key: mcp.name, title: mcp.name, detail: `${mcp.type} · ${mcp.detail}` }))
    return current.skills.map((skill) => ({ key: skill.name, title: skill.name, detail: skill.path }))
  })

  async function act(item: Item, operation: "install" | "remove") {
    if (pending().has(item.id)) return
    setPending((current) => new Set(current).add(item.id))
    setNote("")
    try {
      const call = operation === "install" ? props.admin.install : props.admin.remove
      const response = await call({ item })
      setNote(response.message)
      props.ctx.toast.show({
        title: "Marketplace",
        description: response.message,
        variant: response.ok ? "success" : "error",
      })
      await refetchState()
      if (response.ok && response.needsReload) setNeedsReload(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNote(message)
      props.ctx.toast.show({ title: "Marketplace", description: message, variant: "error" })
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
    }
  }

  async function applyReload() {
    if (reloading()) return
    setReloading(true)
    try {
      const response = await props.admin.reload()
      setNote(response.message)
      if (response.ok) {
        setNeedsReload(false)
        await refetchState()
        props.ctx.layout.settings("market")
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setReloading(false)
    }
  }

  const removeInstalled = async (title: string) => {
    const current = state()
    if (!current) return
    let item: Item | undefined
    if (kind() === "plugin") {
      const found = current.plugins.find((plugin) => plugin.name === title)
      if (found)
        item = {
          id: `plugin:${found.name}`,
          kind: "plugin",
          name: found.name,
          title: found.name,
          description: "",
          version: "",
          homepage: "",
          meta: "",
          installed: true,
        }
    } else if (kind() === "mcp") {
      const found = current.mcps.find((mcp) => mcp.name === title)
      item = {
        id: `mcp:${title}`,
        kind: "mcp",
        name: title,
        title,
        description: "",
        version: "",
        homepage: "",
        meta: "",
        installed: true,
        url: found?.type === "remote" ? found.detail : undefined,
        command: found?.type === "remote" ? undefined : found?.detail.split(" "),
      }
    } else {
      const found = current.skills.find((skill) => skill.name === title)
      item = {
        id: `skill:${title}`,
        kind: "skill",
        name: title,
        title,
        description: "",
        version: "",
        homepage: "",
        meta: "",
        installed: true,
      }
    }
    if (item) await act(item, "remove")
  }

  return (
    <props.ctx.ui.SettingsLayout
      title="Marketplace"
      description="Browse and install plugins, MCP servers and skills. Everything is written to your global OpenCode config."
      actions={
        <props.ctx.ui.Button
          icon="refresh"
          size="small"
          variant="neutral"
          busy={result.loading || state.loading}
          onClick={() => {
            void Promise.all([refetchCatalog(), refetchState()])
          }}
        >
          Refresh
        </props.ctx.ui.Button>
      }
    >
      <div style={BAR}>
        <For each={KINDS}>
          {(entry) => (
            <props.ctx.ui.Button
              icon={entry.icon}
              size="small"
              variant={kind() === entry.kind ? "contrast" : "neutral"}
              onClick={() => setKind(entry.kind)}
            >
              {entry.label}
            </props.ctx.ui.Button>
          )}
        </For>
        <Show when={pending().size > 0}>
          <span style={{ ...MUTED, "font-size": "11px" }}>{pending().size} running…</span>
        </Show>
      </div>

      <div style={BAR}>
        <div style={{ flex: "1 1 220px", "min-width": "180px" }}>
          <props.ctx.ui.TextInput
            value={draft()}
            onInput={setDraft}
            onSubmit={(value) => setQuery(value)}
            label="Search the marketplace"
            placeholder={kind() === "plugin" ? "Search npm for OpenCode plugins" : kind() === "mcp" ? "Search MCP servers" : "Search skills"}
            type="search"
          />
        </div>
        <props.ctx.ui.Button size="small" variant="neutral" onClick={() => setQuery(draft())}>
          Search
        </props.ctx.ui.Button>
        <Show when={query().length > 0}>
          <props.ctx.ui.Button
            size="small"
            variant="ghost-muted"
            onClick={() => {
              setDraft("")
              setQuery("")
            }}
          >
            Clear
          </props.ctx.ui.Button>
        </Show>
      </div>

      <Show when={note().length > 0}>
        <p style={{ ...MUTED, margin: "0 0 10px" }}>{note()}</p>
      </Show>

      <Show when={needsReload()}>
        <div style={{ ...BAR, padding: "8px 10px", border: "1px solid var(--border-weak, #333)", "border-radius": "6px" }}>
          <span style={{ flex: "1 1 220px", "font-size": "12px" }}>
            A plugin was installed. Reload to load it — this page reopens afterwards.
          </span>
          <props.ctx.ui.Button size="small" variant="contrast" busy={reloading()} onClick={() => void applyReload()}>
            Reload
          </props.ctx.ui.Button>
        </div>
      </Show>

      <props.ctx.ui.SettingsSection
        title={`${KINDS.find((entry) => entry.kind === kind())?.label ?? ""} · ${visible().length}`}
        footer={
          <Show when={result()?.error}>
            <p style={{ color: "var(--text-danger, #e5484d)", margin: "8px 0 0" }}>{result()!.error}</p>
          </Show>
        }
      >
        <Show
          when={!result.loading || visible().length > 0}
          fallback={<p style={{ padding: "12px", ...MUTED }}>Loading…</p>}
        >
          <Show
            when={visible().length > 0}
            fallback={<p style={{ padding: "12px", ...MUTED }}>Nothing matched. Try a different search.</p>}
          >
            <For each={visible().slice(0, 120)}>
              {(item) => (
                <props.ctx.ui.SettingsRow
                  title={
                    <span style={ROW}>
                      {item.title}
                      <Show when={item.version.length > 0}>
                        <span style={{ ...MUTED, "font-size": "11px" }}>v{item.version}</span>
                      </Show>
                    </span>
                  }
                  description={
                    <span>
                      {item.description}
                      <br />
                      <span style={{ ...MUTED, "font-size": "11px" }}>{item.meta}</span>
                    </span>
                  }
                >
                  <div style={ROW}>
                    <Show when={item.homepage.length > 0}>
                      <props.ctx.ui.IconButton
                        icon="globe"
                        label="Open project page"
                        onClick={() => props.ctx.system.openExternal(item.homepage)}
                      />
                    </Show>
                    <Show
                      when={!isInstalled(item)}
                      fallback={
                        <props.ctx.ui.Button
                          icon="trash"
                          size="small"
                          variant="danger"
                          busy={pending().has(item.id)}
                          onClick={() => void act(item, "remove")}
                        >
                          Remove
                        </props.ctx.ui.Button>
                      }
                    >
                      <props.ctx.ui.Button
                        icon="download"
                        size="small"
                        variant="contrast"
                        busy={pending().has(item.id)}
                        onClick={() => void act(item, "install")}
                      >
                        Install
                      </props.ctx.ui.Button>
                    </Show>
                  </div>
                </props.ctx.ui.SettingsRow>
              )}
            </For>
          </Show>
        </Show>
      </props.ctx.ui.SettingsSection>

      <div style={{ "margin-top": "20px" }} />

      <props.ctx.ui.SettingsSection
        title={`Installed ${KINDS.find((entry) => entry.kind === kind())?.label.toLowerCase() ?? ""} · ${installedRows().length}`}
      >
        <Show when={installedRows().length > 0} fallback={<p style={{ padding: "12px", ...MUTED }}>Nothing installed yet.</p>}>
          <For each={installedRows()}>
            {(row) => (
              <props.ctx.ui.SettingsRow title={row.title} description={<span style={{ "font-size": "11px" }}>{row.detail}</span>}>
                <props.ctx.ui.Button
                  icon="trash"
                  size="small"
                  variant="ghost"
                  busy={pending().has(`${kind()}:${row.key}`)}
                  onClick={() => void removeInstalled(row.title)}
                >
                  Remove
                </props.ctx.ui.Button>
              </props.ctx.ui.SettingsRow>
            )}
          </For>
        </Show>
      </props.ctx.ui.SettingsSection>

      <p style={{ ...MUTED, "font-size": "11px", "margin-top": "14px" }}>
        Config: {state()?.configPath ?? "…"} · Skills: {state()?.skillsDir ?? "…"}
      </p>
    </props.ctx.ui.SettingsLayout>
  )
}
