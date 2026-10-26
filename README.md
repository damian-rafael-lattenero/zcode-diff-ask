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
│   · turn-events.jsonl         # INBOX de turnos: cada prompt del usuario
│   │                           #   (hook user-scope del bot) → el server
│   │                           #   fotografía (HEAD + blobs hash-object -w)
│   · turn://list               # turnos registrados (índice persistente)
│   · diff://turn/<id|latest>   # diff del turno; latest = contra el árbol VIVO
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
- **Turnos**: cada mensaje del usuario en CUALQUIER sesión de la Mac
  (desktop o Telegram — el hook user-scope del bot lo escribe todo) apendea
  un evento a `~/.zcode/diff-ask/turn-events.jsonl`; el server del plugin lo
  observa SIN debounce y fotografía el estado ANTES de que el agente edite:
  HEAD + blobs de git (`hash-object -w`) por archivo sucio. El diff del
  turno N = foto(prompt N) vs foto(prompt N+1) — el EFECTO NETO, haya
  commiteado o no; el ÚLTIMO turno diffea contra el working tree VIVO y nace
  abierto por default. La lista muestra `fecha hora · prompt recortado ·
  💬 prompt completo · ✕ borrar` + "Borrar todo" con confirmación inline.
  Persiste entre sesiones: índice en `~/.zcode/diff-ask/turns/<key>/` y
  blobs en el propio `.git/objects` del repo (los recoge el gc).
- **Commits**: últimos 10 con `hash · título · autor · fecha`, "…" trae 10
  más, y buscador por hash (exacto o prefijo) o texto del título. Un click
  abre el diff del commit (vs primer padre; merge anotado) y las preguntas
  se anclan igual que en cualquier modo, con el commit nombrado en el
  encabezado del mensaje.
- **↩ revert estilo IDE, por LÍNEA** (0.6.0/0.6.1): tres niveles —
  hover una línea cambiada → **↩ en el riel DERECHO** (donde los 💬) revierte
  ESA línea sola (agregada se quita / borrada vuelve); **selección** de
  cajitas o texto multilínea (verde o rojo por igual, salteadas incluidas) →
  ↩ junto al ＋ revierte EXACTAMENTE esas líneas; **↩ en el head** = archivo
  completo. Reconstrucción pura y testeada (`revertLines` en lib, sobre el
  alineamiento `hunkContent` de cada hunk — el resto del archivo no se
  toca); escritura por `write_file` → AGENTE GANA. Bloqueado durante la
  edición ✏️ del archivo.
- **Selección con contraste** (0.6.0): `::selection` con acento/contraste en
  ambos temas, también inyectada al shadow DOM de pierre (compite con los
  fondos verde/rojo y gana).
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
- **≡ oculta TODO el contexto** (0.3.2): pierre marca `context` el umbral
  renderizado y `context-expanded` el que el usuario expandió de un
  separador — el filtro oculta AMBAS clases (si no, las expandidas quedaban
  colgadas y parecía que "solo se ocultaban las cercanas").
- **Toolbar sticky** (0.3.2): barra de modos + header siempre visibles al
  scrollear (también en la vista Commits y en los estados de error).
- **✏️ edición en vivo** (0.5.0): el panel ES un editor — ✏️ en el head del
  archivo (sólo vistas del working tree: Trabajo, Sin pushear, turno EN VIVO)
  engancha el `Editor` de pierre al diff y cada tecla re-difiera en vivo
  (verde/rojo al instante, sesión de edición hunk-por-hunk). Guardado estilo
  IntelliJ (save-all-always): autosave con debounce 900ms vía `write_file`,
  ⌘Z/⌘⇧Z nativos, y ↩ Descartar (N) restaura el contenido de antes del ✏️.
  Mientras editás, el refresh reactivo queda en pausa (chip honesto) y se
  aplica solo al terminar. Conflicto = GANA EL AGENTE: si el archivo cambió
  en disco desde tu base (sha1), no se pisa — tu versión va a un shelve
  (`~/.zcode/diff-ask/shelved/<ws>/` con el contenido completo + `.patch`
  con la diferencia) y la edición se cierra. Mandar preguntas desde el panel
  hace save-all antes de enviar.
- **📁 carpeta del diff** (0.3.2): chip con la carpeta que se está diffeando
  (título = ruta completa). Click → editor para cambiar a cualquier repo
  local (tool `set_workspace`): el server valida que sea repo git, re-arma
  los watchers reactivos y el panel limpia TODO el estado anclado (era de
  la carpeta vieja) y refresca. Los payloads siempre traen `workspace`.

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
