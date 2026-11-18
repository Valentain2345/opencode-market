import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import type { JSX } from "solid-js"

import type { IpcClient, SetupContext } from "@opencode/plugin/gui"
import type { CatalogResult, Item, Kind, Market, MarketState, SourcesState } from "../contract"
import { SOURCE_LABEL, SOURCE_TYPES, type MarketSource, type SourceType } from "../source-schema"

const KINDS: { kind: Kind; label: string; icon: "extensions" | "mcp" | "graduation-cap" }[] = [
  { kind: "plugin", label: "Plugins", icon: "extensions" },
  { kind: "mcp", label: "MCP servers", icon: "mcp" },
  { kind: "skill", label: "Skills", icon: "graduation-cap" },
]

const MUTED: JSX.CSSProperties = { color: "var(--text-weak, #888)" }
const ROW: JSX.CSSProperties = { display: "flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }
const BAR: JSX.CSSProperties = { display: "flex", gap: "8px", "align-items": "center", "margin-bottom": "12px", "flex-wrap": "wrap" }
const PANEL: JSX.CSSProperties = {
  border: "1px solid var(--border-weak, #333)",
  "border-radius": "6px",
  padding: "10px",
  "margin-top": "10px",
  "max-width": "100%",
  "box-sizing": "border-box",
}
const FIELD: JSX.CSSProperties = { flex: "1 1 160px", "min-width": 0 }
const FIELDS: JSX.CSSProperties = {
  display: "grid",
  gap: "8px",
  "grid-template-columns": "repeat(2, minmax(0, 1fr))",
  "align-items": "end",
  "margin-bottom": "10px",
  width: "100%",
  "box-sizing": "border-box",
}

const MCP_DEFAULT = "https://registry.modelcontextprotocol.io/v0/servers"
const PAGE_SIZE = 25

function keyOf(kind: Kind, query: string, all: boolean): string {
  return `${kind}|${query}|${all ? "all" : "paged"}`
}

function labelOf(kind: Kind): string {
  return KINDS.find((entry) => entry.kind === kind)?.label ?? kind
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sourceTarget(source: MarketSource): string {
  if (source.repo) return `${source.repo}${source.path ? `/${source.path}` : ""}${source.ref ? `@${source.ref}` : ""}`
  return source.url ?? "built-in registry"
}

export function MarketPage(props: { ctx: SetupContext<{}>; admin: IpcClient<typeof Market.spec> }) {
  const [kind, setKind] = createSignal<Kind>("plugin")
  const [draft, setDraft] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [cache, setCache] = createSignal<ReadonlyMap<string, CatalogResult>>(new Map())
  const [loadingKeys, setLoadingKeys] = createSignal<ReadonlySet<string>>(new Set())
  const inflight = new Set<string>()
  const [state, setState] = createSignal<MarketState>()
  const [stateLoading, setStateLoading] = createSignal(false)
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const [needsReload, setNeedsReload] = createSignal(false)
  const [reloading, setReloading] = createSignal(false)
  const [note, setNote] = createSignal("")
  const [page, setPage] = createSignal(0)
  const [all, setAll] = createSignal(false)

  const [showSources, setShowSources] = createSignal(false)
  const [sourcesState, setSourcesState] = createSignal<SourcesState>()
  const [sourceType, setSourceType] = createSignal<SourceType>("npm")
  const [sourceId, setSourceId] = createSignal("")
  const [sourceUrl, setSourceUrl] = createSignal("")
  const [sourceRepo, setSourceRepo] = createSignal("")
  const [sourcePath, setSourcePath] = createSignal("")
  const [sourceRef, setSourceRef] = createSignal("")
  const [addingSource, setAddingSource] = createSignal(false)

  const currentKey = createMemo(() => keyOf(kind(), query(), all()))
  const current = createMemo(() => cache().get(currentKey()))
  const catalogBusy = createMemo(() => loadingKeys().has(currentKey()))

  async function loadKind(target: Kind, search: string, force: boolean, every = false) {
    const key = keyOf(target, search, every)
    if (inflight.has(key)) return
    inflight.add(key)
    setLoadingKeys((keys) => new Set(keys).add(key))
    try {
      const value = await props.admin.catalog({ kind: target, query: search, force, all: every })
      setCache((values) => new Map(values).set(key, value))
    } catch (error) {
      const value: CatalogResult = { items: [], error: messageOf(error), source: "", fetchedAt: Date.now() }
      setCache((values) => new Map(values).set(key, value))
    } finally {
      inflight.delete(key)
      setLoadingKeys((keys) => {
        const next = new Set(keys)
        next.delete(key)
        return next
      })
    }
  }

  async function loadState() {
    setStateLoading(true)
    try {
      setState(await props.admin.installed())
    } catch (error) {
      setNote(messageOf(error))
    } finally {
      setStateLoading(false)
    }
  }

  async function loadSources() {
    try {
      setSourcesState(await props.admin.sources())
    } catch (error) {
      setSourcesState({ sources: [], path: "", error: messageOf(error) })
    }
  }

  createEffect(() => {
    const target = kind()
    const search = query()
    void loadKind(target, search, false, all())
  })

  // Any new view starts at its first page.
  createEffect(() => {
    kind()
    query()
    all()
    draft()
    setPage(0)
  })

  createEffect(() => {
    const types = SOURCE_TYPES[kind()]
    if (!types.includes(sourceType())) setSourceType(types[0] ?? "catalog")
  })

  onMount(() => {
    void loadState()
    void loadSources()
    // Warm the other tabs so switching never waits on the network.
    void loadKind("mcp", "", false)
    void loadKind("skill", "", false)
  })

  const isInstalled = (item: Item): boolean => {
    const latest = state()
    if (!latest) return item.installed
    if (item.kind === "plugin") return latest.plugins.some((plugin) => plugin.name === item.name)
    if (item.kind === "mcp")
      return latest.mcps.some(
        (mcp) => (item.url !== undefined && mcp.detail === item.url) || (item.command !== undefined && mcp.detail === item.command.join(" ")),
      )
    return latest.skills.some((skill) => skill.name === item.name)
  }

  const visible = createMemo(() => {
    const text = draft().trim().toLowerCase()
    const items = current()?.items ?? []
    if (text.length === 0) return items
    return items.filter((item) => `${item.title} ${item.name} ${item.description}`.toLowerCase().includes(text))
  })

  const installedRows = createMemo(() => {    const latest = state()
    if (!latest) return []
    if (kind() === "plugin") return latest.plugins.map((plugin) => ({ key: plugin.name, title: plugin.name, detail: plugin.spec }))
    if (kind() === "mcp") return latest.mcps.map((mcp) => ({ key: mcp.name, title: mcp.name, detail: `${mcp.type} · ${mcp.detail}` }))
    return latest.skills.map((skill) => ({ key: skill.name, title: skill.name, detail: skill.path }))
  })

  const pageCount = createMemo(() => Math.max(1, Math.ceil(visible().length / PAGE_SIZE)))
  const pageSafe = createMemo(() => Math.min(page(), pageCount() - 1))
  const pageItems = createMemo(() => visible().slice(pageSafe() * PAGE_SIZE, (pageSafe() + 1) * PAGE_SIZE))

  async function act(item: Item, operation: "install" | "remove") {
    if (pending().has(item.id)) return
    setPending((current) => new Set(current).add(item.id))
    setNote("")
    try {
      const call = operation === "install" ? props.admin.install : props.admin.remove
      const response = await call({ item })
      setNote(response.message)
      props.ctx.toast.show({ title: "Marketplace", description: response.message, variant: response.ok ? "success" : "error" })
      await loadState()
      if (response.ok && response.needsReload) setNeedsReload(true)
    } catch (error) {
      const message = messageOf(error)
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
        await loadState()
        props.ctx.layout.settings("market")
      }
    } catch (error) {
      setNote(messageOf(error))
    } finally {
      setReloading(false)
    }
  }

  const removeInstalled = async (title: string) => {
    const latest = state()
    if (!latest) return
    let item: Item | undefined
    if (kind() === "plugin") {
      const found = latest.plugins.find((plugin) => plugin.name === title)
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
      const found = latest.mcps.find((mcp) => mcp.name === title)
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

  async function submitSource() {
    if (addingSource()) return
    const type = sourceType()
    const id = sourceId().trim()
    if (id.length === 0) {
      setNote("Give the new source an id, for example acme.")
      return
    }
    const source: MarketSource = { id, kind: kind(), type, enabled: true }
    if (type === "catalog" || type === "mcp-registry") source.url = sourceUrl().trim() || (type === "mcp-registry" ? MCP_DEFAULT : "")
    if (type === "github" || type === "github-skills") {
      source.repo = sourceRepo().trim()
      source.path = sourcePath().trim()
      if (sourceRef().trim().length > 0) source.ref = sourceRef().trim()
    }
    setAddingSource(true)
    try {
      const response = await props.admin.addSource({ source })
      setSourcesState(response)
      if (response.error.length > 0) {
        props.ctx.toast.show({ title: "Marketplace", description: response.error, variant: "error" })
        return
      }
      setNote(`Added source "${id}".`)
      setSourceId("")
      setSourceUrl("")
      setSourceRepo("")
      setSourcePath("")
      setSourceRef("")
      setCache(new Map())
      void loadKind(kind(), query(), true)
      props.ctx.toast.show({ title: "Marketplace", description: `Added source "${id}".`, variant: "success" })
    } catch (error) {
      setNote(messageOf(error))
    } finally {
      setAddingSource(false)
    }
  }

  async function dropSource(id: string) {
    try {
      const response = await props.admin.removeSource({ id })
      setSourcesState(response)
      if (response.error.length > 0) {
        props.ctx.toast.show({ title: "Marketplace", description: response.error, variant: "error" })
        return
      }
      setNote(`Removed source "${id}".`)
      setCache(new Map())
      void loadKind(kind(), query(), true)
      props.ctx.toast.show({ title: "Marketplace", description: `Removed source "${id}".`, variant: "success" })
    } catch (error) {
      setNote(messageOf(error))
    }
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
          busy={catalogBusy() || stateLoading()}
          onClick={() => void Promise.all([loadKind(kind(), query(), true, all()), loadState()])}
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
        <props.ctx.ui.Button
          icon="bullet-list"
          size="small"
          variant={all() ? "contrast" : "ghost-muted"}
          onClick={() => setAll((value) => !value)}
        >
          All results
        </props.ctx.ui.Button>
        <props.ctx.ui.Button
          icon="globe"
          size="small"
          variant={showSources() ? "contrast" : "ghost-muted"}
          onClick={() => setShowSources((value) => !value)}
        >
          Sources
        </props.ctx.ui.Button>
      </div>

      <div style={BAR}>
        <div style={{ flex: "1 1 220px", "min-width": "180px" }}>
          <props.ctx.ui.TextInput
            value={draft()}
            onInput={setDraft}
            onSubmit={(value) => setQuery(value)}
            label="Search the marketplace"
            placeholder={
              kind() === "plugin" ? "Search npm for OpenCode plugins" : kind() === "mcp" ? "Search MCP servers" : "Search skills"
            }
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

      <Show when={showSources()}>
        <props.ctx.ui.SettingsSection
          title="Sources"
          footer={
            <p style={{ ...MUTED, "font-size": "11px", "overflow-wrap": "anywhere" }}>
              {sourcesState()?.path ? `File: ${sourcesState()!.path}` : " "}
              <Show when={sourcesState()?.error}>
                <br />
                <span style={{ color: "var(--text-danger, #e5484d)" }}>{sourcesState()!.error}</span>
              </Show>
            </p>
          }
        >
          <Show
            when={(sourcesState()?.sources.length ?? 0) > 0}
            fallback={<p style={{ padding: "12px", ...MUTED }}>No sources yet. Add one below.</p>}
          >
            <For each={sourcesState()!.sources}>
              {(source) => (
                <props.ctx.ui.SettingsRow
                  title={
                    <span style={ROW}>
                      {source.id}
                      <span style={{ ...MUTED, "font-size": "11px" }}>{SOURCE_LABEL[source.type as SourceType] ?? source.type}</span>
                    </span>
                  }
                  description={<span style={{ "font-size": "11px", "overflow-wrap": "anywhere" }}>{sourceTarget(source)}</span>}
                >
                  <props.ctx.ui.Button icon="trash" size="small" variant="ghost" onClick={() => void dropSource(source.id)}>
                    Remove
                  </props.ctx.ui.Button>
                </props.ctx.ui.SettingsRow>
              )}
            </For>
          </Show>

          <div style={PANEL}>
            <p style={{ margin: "0 0 8px", "font-size": "12px" }}>Add a source for {labelOf(kind()).toLowerCase()}</p>
            <div style={BAR}>
              <For each={SOURCE_TYPES[kind()]}>
                {(type) => (
                  <props.ctx.ui.Button
                    size="small"
                    variant={sourceType() === type ? "contrast" : "neutral"}
                    onClick={() => setSourceType(type)}
                  >
                    {SOURCE_LABEL[type]}
                  </props.ctx.ui.Button>
                )}
              </For>
            </div>
            <div style={FIELDS}>
              <div style={FIELD}>
                <props.ctx.ui.TextInput value={sourceId()} onInput={setSourceId} label="Source id" placeholder="acme" />
              </div>
              <Show when={sourceType() === "catalog" || sourceType() === "mcp-registry"}>
                <div style={FIELD}>
                  <props.ctx.ui.TextInput
                    value={sourceUrl()}
                    onInput={setSourceUrl}
                    label="Catalog URL"
                    placeholder={sourceType() === "mcp-registry" ? MCP_DEFAULT : "https://example.com/plugins.json"}
                  />
                </div>
              </Show>
              <Show when={sourceType() === "github" || sourceType() === "github-skills"}>
                <div style={FIELD}>
                  <props.ctx.ui.TextInput value={sourceRepo()} onInput={setSourceRepo} label="Repository" placeholder="owner/repo" />
                </div>
                <div style={FIELD}>
                  <props.ctx.ui.TextInput
                    value={sourcePath()}
                    onInput={setSourcePath}
                    label="Path"
                    placeholder={sourceType() === "github" ? "plugins.json" : "skills"}
                  />
                </div>
                <div style={FIELD}>
                  <props.ctx.ui.TextInput value={sourceRef()} onInput={setSourceRef} label="Branch" placeholder="main" />
                </div>
              </Show>
            </div>
            <div style={{ display: "flex", "justify-content": "flex-end" }}>
              <props.ctx.ui.Button variant="contrast" size="small" busy={addingSource()} onClick={() => void submitSource()}>
                Add source
              </props.ctx.ui.Button>
            </div>
          </div>
        </props.ctx.ui.SettingsSection>
        <div style={{ "margin-top": "20px" }} />
      </Show>

      <props.ctx.ui.SettingsSection
        title={`${labelOf(kind())} · ${current() ? visible().length : "…"}`}
        footer={
          <Show when={catalogBusy() || current()?.error}>
            <p
              style={{
                ...MUTED,
                margin: "8px 0 0",
                ...(current()?.error ? { color: "var(--text-danger, #e5484d)" } : {}),
              }}
            >
              {current()?.error || (current() ? "Updating…" : `Loading ${labelOf(kind()).toLowerCase()}…`)}
            </p>
          </Show>
        }
      >
        <Show when={current()} fallback={<p style={{ padding: "12px", ...MUTED }}>Loading {labelOf(kind()).toLowerCase()}…</p>}>
          <Show
            when={visible().length > 0}
            fallback={<p style={{ padding: "12px", ...MUTED }}>Nothing matched. Try a different search.</p>}
          >
            <For each={pageItems()}>
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
            <Show when={visible().length > PAGE_SIZE}>
              <div style={{ ...BAR, "justify-content": "space-between", "margin-top": "10px" }}>
                <span style={{ ...MUTED, "font-size": "11px" }}>
                  {pageSafe() * PAGE_SIZE + 1}–{Math.min((pageSafe() + 1) * PAGE_SIZE, visible().length)} of {visible().length}
                </span>
                <div style={ROW}>
                  <props.ctx.ui.Button
                    size="small"
                    variant="neutral"
                    onClick={() => {
                      if (pageSafe() > 0) setPage(pageSafe() - 1)
                    }}
                  >
                    Previous
                  </props.ctx.ui.Button>
                  <span style={{ ...MUTED, "font-size": "11px" }}>
                    Page {pageSafe() + 1} / {pageCount()}
                  </span>
                  <props.ctx.ui.Button
                    size="small"
                    variant="neutral"
                    onClick={() => {
                      if (pageSafe() + 1 < pageCount()) setPage(pageSafe() + 1)
                    }}
                  >
                    Next
                  </props.ctx.ui.Button>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </props.ctx.ui.SettingsSection>

      <div style={{ "margin-top": "20px" }} />

      <props.ctx.ui.SettingsSection title={`Installed ${labelOf(kind()).toLowerCase()} · ${installedRows().length}`}>
        <Show
          when={state()}
          fallback={<p style={{ padding: "12px", ...MUTED }}>Loading installed…</p>}
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
        </Show>
      </props.ctx.ui.SettingsSection>

      <p style={{ ...MUTED, "font-size": "11px", "margin-top": "14px" }}>
        Config: {state()?.configPath ?? "…"} · Skills: {state()?.skillsDir ?? "…"}
      </p>
    </props.ctx.ui.SettingsLayout>
  )
}
