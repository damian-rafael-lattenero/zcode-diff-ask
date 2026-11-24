# Diff Ask — el diff vivo de ZCode, preguntable y revertible

Un plugin de ZCode (MCP App) con un panel lateral sobre el diff **vivo** del
workspace. Tres capacidades sobre las mismas líneas:

1. **Preguntar anclado**: hover de cualquier línea → **＋** → la pregunta llega
   a la conversación citando `archivo:línea` + las líneas exactas. El agente
   contesta sobre ESA línea (y puede fijar la respuesta al archivo con
   tarjetas nativas `# Code comments:`).
2. **Revertir quirúrgico (el pincel)**: seleccionás palabras con el mouse —
   doble-click una palabra, triple-click la línea, drag un rango de chars —
   y las **pintás**; Enter o el ↩↩ del toolbar ejecuta el revert de
   EXACTAMENTE esos caracteres, verificado contra git. Funciona en los dos
   lados: pintar en la fila verde borra esos chars; pintar en la roja
   **restaura** esa palabra en su lugar.
3. **Editar en vivo (✏️)**: el panel ES un editor — cada tecla re-difiera,
   autosave con debounce, conflictos resueltos como "gana el agente".

```
┌──────────────────────────────────────────────┐
│ master @ 761da1d · 9 archivos        [↩archivo][＋][✏️][?][↩↩] │
│ ┌──────────────────────────────────────────┐ │
│ │ M  parser.py                   +6 −1     │ │
│ │  2 │ - Marker words: alpha (words), …    │ │ ← roja: "words" resaltada
│ │  2 │ + Marker words: alpha (tokens), …   │ │ ← verde: "tokens" resaltada
│ │        …                                 │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **Vista del diff**: clásica línea a línea, como GitHub — la fila roja con la
  palabra removida resaltada, la verde abajo con la agregada. Una caja por
  palabra (los espacios quedan limpios entre cajas), relleno calculado
  programáticamente desde el color real del diff del tema.
- **Toolbar por archivo** (en orden): `↩` archivo completo · `＋` preguntar ·
  `✏️` editar · `?` modo brocha preguntar · `↩↩` modo brocha revertir
  multilínea (dos flechas apiladas).

Documentación de profundidad:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — arquitectura módulo por
  módulo, el pipeline del pincel/revert, patrones y decisiones de diseño (el
  por qué de cada una).
- **[docs/TESTING.md](docs/TESTING.md)** — la pirámide de tests con tiempos
  reales, cómo funciona el rig e2e con mouse real, y los pozos que fuimos
  aprendiendo.

## What's in it (state 0.11.0)

| Feature | Dónde |
|---|---|
| Diff vivo reactivo (fs.watch → firma git → SSE) | server + panel |
| 2 tabs (0.10.0): **Turnos** (default — el último turno ejecutado, agrupado por repo Y carpeta, git vs "Fuera de git", lista de a 10 hacia el pasado) / **Trabajo por repositorio** (selector 📁 solo acá; default = repo con más cambios del último turno vía `suggest_workspace`; su botón **Commits** abre el historial del repo elegido) | server + panel |
| Turnos v2: ventana prompt→stop por hooks (UserPromptSubmit/Stop), FSEvents sobre $HOME, commits de la ventana + sucios al final, agrupado por repo/worktree | `turns2/` + `turn-tap.nu` |
| **Render lazy** (0.10.0): cada archivo monta su diff recién al expandirlo; colapsar lo destruye — la memoria queda acotada a lo expandido y un turno de 600 archivos no tilda el panel | `hydrateFileDiff`/`dehydrateFileDiff` (panel) |
| **Lazy turn payload** (0.11.0): a turn arrives as headers + counts (`light`), each file's before/after rides its own read on expand/hover — 1.5 MB → ~10 KB per turn switch; per-file contents cached by turn+path+revision | `diff://turn?light=1` + `diff://file` (server), `loadFileContent` (panel) |
| **Loading feedback** (0.11.0): in-flight top bar, skeletons (pending view, lists, file body), spinner on the clicked row/tab, hover prefetch, stale-while-revalidate on switch-back, highlight skipped >200 KB/side | `paintPendingView` + `#loadbar` (panel) |
| **Incremental turn store** (0.11.0): parsed records cached per file (mtime+size) — a new turn re-reads one file, not 8.7k (~2 s → ~50 ms) | `readTurnFiles` (server) |
| **Big-file open fast** (0.11.1): the lib's tokenizer is capped (`tokenizeMaxLength` = 1,200 lines) so a 3.5k-line file renders plain in ~160 ms instead of blocking ~800 ms; colors are our deferred, memoized path (engine booted eagerly, `da-hl-ready` event); the file header shows a spinner while content loads | `hydrateFileDiff` + `hlColorize` + `vendor/shiki-subset` |
| **Zero sleep-based waits** (0.11.1): the panel/server have no blind sleeps; the e2e waits by condition (`waitForExpr` on the page's frame clock), event (`fs.watch`) or quiescence — only gesture cadence and hard deadlines use timers | `tests/e2e` |
| Refresh con short-circuit: payload idéntico → no se reconstruye el DOM | `payloadSig` (panel) |
| Chips ↑ahead/↓behind vs upstream en el header de trabajo (la vista "Sin pushear" se eliminó en 0.10.0; la info queda) | server (payload working) + panel |
| Preguntas ancladas ＋ (línea, rango de cajitas, archivo) | panel + skill |
| Revert por línea (riel derecho), por selección, por archivo | `revertLines` (lib) |
| **Pincel quirúrgico**: pintar chars/palabras, coexistencia por chars, Enter, brocha acumulativa sin popups | `revertFrags` + `surgeryLine`/`restoreOldWords` (lib) |
| ✏️ edición en vivo (autosave 900ms, ⌘Z, ↩ descartar, agente gana) | Editor de pierre + `write_file` |
| Syntax highlighting (12 lenguajes, shiki JS, sin wasm — nushell desde 0.9.19) | `hlColorize` (panel) |
| Borrador del composer sobrevive el refresh reactivo (texto, foco, caret) | `keptComposers` (panel) |
| ⌘F, filtros ＋/−/≡, toolbar sticky, carpeta del diff | panel |

## Arquitectura en una página

```
┌────────────────────────────── ZCode (fork, Electron) ──────────────────────────────┐
│  panel host (iframe zcode-sandbox://plugin-*)        ZCode Helper (__zcode-plugin- │
│ ┌───────────────────────────────────────────┐        -host, stdio)                │
│ │  diff-ask/dist/panel.html (bundle inline) │← MCP →┌───────────────────────────┐ │
│ │  · App SDK (ext-apps): sendMessage,       │       │ server/server.mjs        │ │
│ │    callServerTool                         │       │ (Node stdlib, 0 deps)    │ │
│ │  · <diffs-container> (@pierre/diffs,      │  SSE  │  git: diff/status/log/   │ │
│ │    shadow DOM: FileDiff + Editor)         │←──────│  hash-object/apply       │ │
│ │  · lib.js: TODA la lógica pura del revert │       │  fs.watch → notifica     │ │
│ └───────────────────────────────────────────┘       │  turn-events.jsonl → 📸  │ │
│         skills/diff-ask/SKILL.md (ruteo del modelo) └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **lib.js es pura** (sin DOM): tokenizadores, word-diff LCS, la cirugía de
  chars, restauración del lado viejo, armado de mensajes. Todo unit-testeado
  sin browser.
- **main.js es la cáscara de IO/DOM**: decora por encima del shadow DOM de
  pierre con capas absolutas medidas con `Range.getClientRects()` — casi
  nunca escribe el DOM de pierre (la única excepción documentada:
  `hlColorize`).
- **server.mjs sin dependencias**: habla MCP por stdio con puro Node, todo lo
  que hace es `git` + `fs.watch` + JSON.

Decisiones clave (resumen; el detalle con el por qué en
[ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **Quirúrgico siempre**: pintar borra/restaura solo los chars pintados.
- **Los gestos nativos definen la semántica**: doble-click = palabra,
  triple = línea, drag = rango. El panel no inventa modos de selección.
- **El texto de una fila es su línea de archivo**: los offsets de chars viven
  en el espacio del archivo en disco; toda conversión de coordenadas pasa
  por utilidades únicas y testeadas.
- **El editor manda solo**: en ✏️, ninguna capa del panel toca el archivo
  (lección de un bug real: el colorizador pisaba lo tipado).
- **Colores derivados, nunca fijos**: se muestrea el color real de la fila
  (que puede venir en `lab()`) y el relleno se calcula con oklch relativo /
  color-mix — nada de parsear colores a mano.
- **Conflicto de escritura = gana el agente**: nunca se pisa el disco; tu
  versión va a un shelve con `.patch`.

## Testing (resumen; detalles en [TESTING.md](docs/TESTING.md))

| Nivel | Qué | Cantidad | Tiempo |
|---|---|---|---|
| Unit | lib.js pura + server MCP (con repos git reales en tmp) | 105 | **~9 s** |
| Integración | lib → `write_file` → `git diff` cierra el circuito en repo tmp real | (dentro de unit) | — |
| E2E | Chromium real + CDP, **mouse y teclado reales**, panel dist real + server real, cada revert verificado con git | 182 checks | **~2 min** (la sección del mega commit suma render de 600 secciones) |

```bash
npm test          # 105 unit + integración (~9 s)
npm run test:e2e  # rig completo con mouse real (~2 min)
```

El e2e usa un fixture determinista (`tests/diffs/` commiteado +
`apply-fixture-mods.mjs` que resetea desde HEAD y aplica 22 edits), y un
popurrí de 42 edits (`apply-fixture-rich.mjs`) para prueba manual.

## Instalación y desarrollo

```bash
npm install && npm run build   # → diff-ask/dist/panel.html (inline, ~3.6 MB)
```

Instalación por UI: ZCode → Plugin Marketplace → Add → apuntar a este repo →
Personal → dev-zcode-diff-ask-… → Diff Ask → Install. Reiniciar ZCode tras
cada update (el panel se sirve del cache al arrancar).

Instalación por script (la cadena completa, ver
[TESTING.md](docs/TESTING.md#instalación)): rsync a la copia del marketplace
(`~/.zcode/cli/plugins/marketplaces/dev-…/`), crear
`~/.zcode/cli/plugins/cache/dev-…/diff-ask/<version>/`, y parchar
`installed_plugins.json` (con backup).

Otros comandos: `npm run check` (contrato MCP del server por stdio),
`diff-ask/dist/dev.html` (harness visual del panel sin la app).

## Roadmap

- [ ] `tools/patch-zcode.sh` — encender el "＋" dentro del diff NATIVO de la
  app (parche del asar + codesign ad-hoc; requiere congelar auto-update).
