# Diff Ask — "+" por línea en el diff de ZCode

Un plugin de ZCode (MCP App) que agrega un panel lateral **Diff Ask** con el
diff **vivo** del workspace y un botón **+** en cada línea: hover → + →
escribís la pregunta → llega a la conversación anclada a `archivo:línea` con
las líneas exactas citadas. El agente contesta sobre esa línea.

```
┌──────────────────────────────┐
│ master @ f2ef6b3 · 2 archivos │  ⟳
│ Pasá el mouse por una línea…  │
│ ┌──────────────────────────┐ │
│ │ M  poller.py      +12 −3 │ │
│ │  41 │ def _nuclear(x):   │ │ ← hover → [+] → composer
│ │  42 │     caffeinate...  │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

## Qué son los "Mods" y qué tiene que ver esto

Claude Code sacó (octubre 2026) los **Mods**: plugins cuyo punto de entrada es
un *hooks module* (JS/TS) que corre **dentro** del proceso de Claude Code.
`register(on)` suscribe handlers a eventos (`tool.call`, `ui.render`,
`command.run`, …) que pueden observar, reescribir o responder cada evento —
pueden dibujar UI (paneles, spinner, filas de tool calls), interceptar tool
calls y reescribir prompts. Tres archivos: `.claude-plugin/plugin.json`,
`hooks/hooks.json` (con clave `modules`), `register.js`.

**ZCode no tiene sistema de mods.** Sus superficies de extensión son: skills,
slash commands, hooks (shell, 7 eventos, sin UI), MCP servers y plugins; y la
única UI extendible oficial son los **MCP Apps** (`ui.surfaces`): paneles
webview de sesión con ida y vuelta al modelo. Este repo es el equivalente
ZCode de un mod: un plugin con server MCP propio + panel interactivo.

Dato de por qué esto existe: el diff nativo de ZCode (3.16.2) ya tiene la
maquinaria de comentarios (`@pierre/diffs` `enableGutterUtility` + composer
`codeViewer.comment.*` + protocolo `# Code comments:`) pero solo cableada para
preview de archivo completo — nunca para el diff de edits del agente. Este
plugin trae esa experiencia a un panel propio; `tools/patch-zcode.sh`
(planificado) la encendería dentro del diff nativo.

## Arquitectura

```
diff-ask/
├── .zcode-plugin/plugin.json   # manifest: mcpServers (stdio vía ZCode Helper) + ui.surfaces
├── server/server.mjs           # MCP server (Node stdlib, cero deps)
│   · ui://diff-ask/panel.html  # sirve el panel (mimeType text/html;profile=mcp-app)
│   · diff://workspace          # JSON del diff — 4 modos (barra arriba en el panel):
│   │     working (default)       git diff HEAD + untracked
│   │     ?mode=unpushed          git diff @{upstream} + untracked, con ↑ahead ↓behind
│   │     ?mode=last-turn         working tree vs 📸 (snapshot de turno del server)
│   · log://commits?skip=&q=    # commits: página de 10 con hasMore ("…" carga más)
│   │                           #   y búsqueda por hash/prefijo o texto del título
│   · diff://commit/<hash>      # diff de un commit vs su primer padre (raíz: árbol vacío)
│   · resources/subscribe       # reactivo: fs.watch(worktree + .git) → firma git
│   │                           #   (status + numstat + HEAD + upstream) → updated
│   └── tools                   # get_diff(mode) · list_commits · get_commit_diff
│                               #   · mark_turn_snapshot (📸)
├── ui/
│   ├── src/main.js             # panel: App (ext-apps SDK) + FileDiff (@pierre/diffs 1.6.1)
│   │                           #   barra de modos + vista Commits + 📸 manual;
│   │                           #   "Enviar todo" marca 📸 ANTES de mandar (línea de
│   │                           #   base del turno) y el header del mensaje nombra el
│   │                           #   scope ("sin pushear…", "commit …", "último turno")
│   ├── src/panel.css           # estilos light/dark
│   ├── vendor/stub-*.mjs       # stubs del highlighter (shiki ~14MB → plain diff, ver abajo)
│   └── build.mjs               # esbuild iife → dist/panel.html autocontenido (<4MiB)
├── skills/diff-ask/SKILL.md    # el modelo: cómo llegar preguntas ancladas y
│                               #   responder con "# Code comments:" (tarjetas nativas)
└── dist/                       # panel.html (build) + dev.html (harness visual)
```

### Modos y "último turno 📸"

- **Trabajo**: el clásico `git diff HEAD` + untracked.
- **Sin pushear**: todo lo que subiría un `git push` más los cambios locales
  (base `@{upstream}`), con cuenta `↑ahead ↓behind`. Sin upstream → mensaje
  con el `git push -u` para salir.
- **Último turno**: el server no ve los turnos de la sesión (la SDK de MCP
  Apps no expone eventos), así que la línea de base es un **marcador 📸**:
  el panel lo pone SOLO antes de mandar cada tanda de preguntas (base =
  arranque del turno) y hay 📸 manual. El diff muestra working tree vs ese
  snapshot — incluye lo que el agente commiteó durante el turno, y los
  archivos restaurados (cambiaron respecto del marcador). In-memory: vive
  mientras viva el proceso del server de la sesión.
- **Commits**: últimos 10 con `hash · título · autor · fecha`, "…" trae 10
  más, y buscador por hash (exacto o prefijo) o texto del título. Un click
  abre el diff del commit (vs primer padre; merge anotado) y las preguntas
  se anclan igual que en cualquier modo, con el commit nombrado en el
  encabezado del mensaje.
- **⌘F** (0.3.1): búsqueda propia del panel — el webview no tiene find
  nativo (y el shadow DOM lo rompería). Barra con contador, Enter/⇧Enter
  cicla y centra la fila actual, Esc cierra y limpia. Coincidencia = fila
  cuyo texto contiene el query (case-insensitive); respeta los filtros de
  visibilidad y re-marca al refrescar el diff o expandir un separador (sin
  mover el scroll). Si el match vive en un archivo colapsado, lo expande al
  saltar.
- **Filtros ＋/−/≡** (0.3.1): toggles de visibilidad por tipo de línea —
  agregadas, borradas, contexto. La celda del gutter de pierre lleva el
  MISMO `data-line-type` que su fila, así que se ocultan simétrico por CSS
  (`:host(.da-hide-*)`) y las columnas quedan alineadas; con el contexto
  oculto los separadores de hunk se van también (existen para él).

- **El "+" y el composer**: `FileDiff` de `@pierre/diffs` — la MISMA librería
  que usa el diff nativo de la app — con `enableGutterUtility: true` y
  `onGutterUtilityClick(range)` → `app.sendMessage({role:"user", content:[…]}`
  con `- \`path:line\` (Diff Ask · diff, líneas a-b · side):` + líneas citadas.
- **Highlighter stubeado**: `@pierre/diffs` arrastra todo shiki + wasm
  (~14 MB) por imports dinámicos; el host limita un recurso HTML a 4 MiB. Los
  stubs implementan la interfaz exacta que el renderer consume
  (`name/getTheme/codeToTokens/hasLoadedLanguages`) y devuelven tokens planos
  → diff plano con colores +/- del tema (misma degradación que la app ante
  lenguajes desconocidos). Panel final: 1.2 MB.
- **Contenedor**: el contenido vive en el shadow DOM de `<diffs-container>`
  (el custom element de la lib trae el stylesheet core) — un div plano
  renderiza sin estilos.
- **Diff vivo**: el server observa el worktree (fs.watch recursivo + .git,
  debounce 600 ms) y solo notifica cuando cambia la firma de git
  (status+numstat+HEAD); el panel re-lee `diff://workspace` al recibir
  `notifications/resources/updated`.

## Instalación (local, dev marketplace)

1. Build: `npm install && npm run build` (genera `diff-ask/dist/panel.html`).
2. ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace** → pegar:
   `/Users/lattenero/Projects/zcode-diff-ask`
3. **Personal → dev-zcode-diff-ask-… → Diff Ask → Install**.
4. En una sesión de un repo git: abrir el panel **Diff Ask** (icono git-compare).

Actualizar tras cambiar código: `npm run build`, bump de `version` en
`diff-ask/.zcode-plugin/plugin.json` + `marketplace.json`, y
**Personal → … → Update**.

## Desarrollo

- `npm run check` — contrato del server MCP por stdio (initialize, resources,
  tools/get_diff, subscribe). Acepta un path de repo: `npm run check -- /tmp/x`.
- `diff-ask/dist/dev.html` — harness visual: abre en cualquier browser con un
  diff real embebido (`window.__DA_TEST__`); el envío se simula.
- Pozo conocido: los eventos sintéticos de hover necesitan
  `pointerType:'mouse'` (el InteractionManager filtra el resto); el utility
  dispara en `pointerdown`, no en click.

## Roadmap

- [ ] F5: `tools/patch-zcode.sh` — parche del asar para encender el "+" en el
  diff NATIVO (backup + re-hash Info.plist + codesign ad-hoc + unpatch).
      Requiere congelar auto-update o re-parchear tras cada actualización.
