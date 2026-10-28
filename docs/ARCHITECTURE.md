# Arquitectura de Diff Ask

Documento de profundidad: qué hace cada pieza, cómo se conectan, y **por qué**
es como es. Para el panorama general, ver el [README](../README.md). Para los
tests, [TESTING.md](TESTING.md).

---

## 1. Mapa de componentes

```
zcode-diff-ask/
├── diff-ask/                       ← el plugin (todo lo que se instala)
│   ├── .zcode-plugin/plugin.json   manifest: mcpServers (stdio) + ui.surfaces
│   ├── server/server.mjs           server MCP (Node stdlib, CERO deps)
│   ├── ui/
│   │   ├── src/lib.js              LÓGICA PURA: word-diff, cirugía de chars,
│   │   │                           restauración, mensajes. Sin DOM. ~500 líneas.
│   │   ├── src/main.js             cáscara DOM/IO del panel. ~3.600 líneas.
│   │   ├── src/panel.css           estilos (light/dark) + capas overlay.
│   │   └── build.mjs               esbuild → dist/panel.html inline (~3,6 MB)
│   ├── skills/diff-ask/SKILL.md    cómo el MODELO rutea las preguntas ancladas
│   └── dist/                       panel.html (build) + dev.html (harness)
├── tests/                          pirámide (ver TESTING.md)
│   ├── *.test.mjs                  unit + integración (node --test)
│   ├── e2e/revert.e2e.mjs          rig e2e con mouse real
│   └── diffs/                      fixture playground (base commiteada)
└── marketplace.json                manifiesto del dev marketplace
```

## 2. Integración con el host (el fork de ZCode)

El plugin no vive solo: depende de cuatro superficies del fork. Entenderlas
explica varias decisiones.

| El fork provee | El plugin hace con eso |
|---|---|
| **Plugin runtime**: `.zcode-plugin/plugin.json` declara `mcpServers` stdio; la app lo levanta vía `ZCode Helper __zcode-plugin-host` | `server.mjs` habla MCP por stdio (initialize/resources/tools/notifications) con puro Node |
| **MCP Apps SDK** (`@modelcontextprotocol/ext-apps`): panel persistente (`ui.surfaces`) con `App.sendMessage` y `app.callServerTool` | El panel manda preguntas como MENSAJES DE USUARIO (anclados) y llama a `write_file`/`get_diff` como tools |
| **Panel host sandboxeado**: el HTML se sirve desde el cache del plugin dentro de un iframe `zcode-sandbox://plugin-<id>` | El bundle es INLINE (un solo `panel.html` sin assets externos), límite del host: 4 MiB |
| **Sistema de skills** | `SKILL.md` le enseña al modelo a reconocer los bloques "Diff Ask" y a responder con `# Code comments:` |

Cadena de instalación (por qué a veces "no se actualiza"):

```
repo (build) → ~/.zcode/cli/plugins/marketplaces/dev-…/   (copia del marketplace)
            → ~/.zcode/cli/plugins/cache/dev-…/diff-ask/<version>/  (lo que SE SIRVE)
            → ~/.zcode/cli/plugins/installed_plugins.json  (registro: version+installPath)
```

La app instala por directorio de versión y sirve desde el `installPath` del
registro. Actualizar = refrescar las TRES cosas + reiniciar ZCode (el panel se
carga al arrancar). Actualizar solo una produce los clásicos "sigue la versión
vieja" o "sirve un dist mixto".

El diff se RENDERIZA con `@pierre/diffs` (la misma lib que el diff nativo de
la app): el custom element `<diffs-container>` monta su **shadow DOM** con las
filas `[data-line]`, su propio tema pierre-dark/light y el `Editor` para
editar. Ese shadow DOM es territorio de pierre — ver §6.

## 3. El server (`server/server.mjs`)

Sin dependencias: MCP por stdio a mano (JSON-RPC línea por línea), y toda la
potencia es `git` + `fs.watch`.

**Resources**
- `diff://workspace[?mode=]` — el diff completo: `working` (HEAD+untracked),
  `unpushed` (@{upstream}+working, con ↑ahead ↓behind), `last-turn`.
  El payload incluye por archivo: status, before/after COMPLETOS (cuando el
  tamaño lo permite), patch unificado, y los `hunks` parseados con su
  `hunkContent` (la estructura cambio-por-cambio que el revert camina).
- `turn://list`, `diff://turn/<id|latest>` — sistema de **turnos 📸**: cada
  prompt del usuario (vía hook user-scope → `~/.zcode/diff-ask/turn-events.jsonl`)
  fotografía el workspace ANTES de que el agente edite (HEAD + blobs
  `hash-object -w` por archivo sucio). El diff del turno N = foto(N) vs
  foto(N+1) = el efecto neto; el último diffea contra el working tree VIVO.
- `log://commits`, `diff://commit/<hash>` — navegador de commits (páginas de
  10 + búsqueda por hash/título).

**Reactividad**: `resources/subscribe` → `fs.watch` (worktree + `.git`,
debounce 600 ms) → solo notifica si cambió la **firma de git** (status +
numstat + HEAD + upstream). El panel re-lee el resource al recibir
`resources/updated`.

**Tools**: `get_diff(mode)` (abre el panel), `list_commits`,
`get_commit_diff`, `list_turns`/`get_turn_diff`, `mark_turn_snapshot` (📸
manual), `set_workspace` (cambiar de repo: re-valida, re-arma watchers) y
**`write_file`** — la única puerta de escritura, con política de conflicto:

```
write_file(path, content, base)
  base = sha1 del archivo cuando lo leíste
  ├─ coincide → escribe
  └─ difiere (el agente tocó el disco mientras tanto) → NO PISA:
     shelve ~/.zcode/diff-ask/shelved/<ws>/<file>.{mine,patch} → "gana el agente"
```

Toda escritura del panel (reverts, edición ✏️, descartes) pasa por acá. La
política es deliberada: el agente nunca pierde trabajo por una edición
humana en el panel, y el humano nunca pierde la suya (queda en el shelve).

## 4. El panel (`ui/src/main.js`) — el mapa de capas

```
<section class="file">                       (light DOM del panel)
  <div class="file-head">  [↩][＋][✏️][?][↩↩]  chev · path · counts
  <div class="file-body">
    <diffs-container>  ← shadow DOM de pierre: filas [data-line], gutter,
    │                    tokens de sintaxis, su propio tema
    └── (nuestro, via shadowRoot): styles inyectados (.da-extra, ::selection)
    <div class="wc-layer">     ← overlay ABSOLUTO: cajas por palabra (roja/verde)
    <div class="frag-layer">   ← overlay ABSOLUTO: franjas de lo pintado
    <div class="anchor-layer"> ← chips 💬 de preguntas ancladas
```

**El modelo de decoración**: pierre es el dueño del DOM del diff. El panel
decora POR ENCIMA con capas absolutas posicionadas midiendo
`Range.getClientRects()` de las filas del shadow. Casi nunca escribe el DOM
de pierre — la única excepción es `hlColorize` (§7) que reemplaza el contenido
de una fila con tokens coloreados. Todo lo demás (cajas, franjas, dots de
espacios) vive en overlays.

Cada pasada de decoración (`markChangedWords`) es:
1. **Pre-gate** (corre SIEMPRE): parear dels↔adds del mismo cambio, reset de
   estado de builds viejos.
2. Muestreo de colores reales (§8) → CSS custom properties.
3. **Gate de firma** (`_wcSig`): si no cambió nada (mismas filas/altura/
   largos), no recomputar rects — el layout no cambió.
4. Recomputar cajas: `changedWordRanges` por pareja → `wordRanges` parte cada
   rango en PALABRAS → una caja por palabra, espacios limpios entre ellas.

## 5. El pincel quirúrgico — pipeline completo (el corazón)

### 5.1 Gestos → selección

Los gestos nativos definen la semántica (decisión: no inventar modos):

| Gesto | Selecciona | Cómo se detecta |
|---|---|---|
| doble-click | una palabra | `click.detail === 2` + walk de límites de palabra Unicode |
| triple-click | la línea entera | `detail >= 3` (el click nativo sabe el conteo real) |
| drag | rango de chars exacto | camino geométrico (abajo) |
| drag vertical | líneas enteras | Δy ≥ 14px y Δx < 8px |

**Hit-testing geométrico**: `caretRangeFromPoint` RETARGEA al shadow host
(inservible), y `String(selection)` miente con los newlines de Chromium. En
su lugar: `shadowRoot.elementFromPoint` sí atraviesa el shadow, y el offset
de carácter se resuelve por **búsqueda binaria sobre rects de Ranges**
internos (`offsetAtX`) — los rects del shadow son geometría real aunque la
Selection no los exponga. Un gesto se representa como `dragPath`
`{x0,y0,x1,y1,at,live,detail}`: `at` = id del gesto (dedupe), `live` =
última actividad (los drags humanos multilínea tardan >1,2 s; el camino
geométrico no puede morir a mitad de gesto). Palabras repetidas en la fila:
la ocurrencia se elige por GEOMETRÍA (el rect más cercano al punto de
release), jamás por `indexOf`.

### 5.2 Selección → frags

Un frag es **siempre offsets de caracteres contra la línea del ARCHIVO**:

```js
{ side: "new"|"old", line: <línea del archivo>, offA, offB }   // [a,b)
```

- Pintar en la fila **verde** → frag `new` (offsets sobre la línea del disco).
- Pintar en la fila **roja** → frag `old` (offsets sobre la línea VIEJA).
- **Coexistencia por chars**: pintar una palabra NO despinta pintadas vecinas
  salvo que solapen caracteres con la nueva (dos palabras de la misma fila
  coexisten; repintar exactamente lo mismo = despintar a propósito).
- **Un gesto = una pintada**: un mismo gesto genera varias `selectionchange`
  (release → settle) y la primera pintada post-release gana (lock por
  `dragPath.at`).

### 5.3 Frags → archivo nuevo (`revertFrags` en lib.js)

Camina los hunks por su `hunkContent` (bloques change/context) manteniendo el
alineamiento viejo↔nuevo. Por cada línea:

- **Línea nueva con pintadas (lado verde)** → `surgeryLine(after, before,
  sels)`: borra exactamente los chars pintados que caen en tokens AGREGADOS
  (word-diff LCS), con reglas de espacios para no dejar dobles espacios ni
  palabras pegadas. Si la pintada cubre **todo el cambio** de la línea
  (`coversFullChange`: la línea completa o todos los rangos agregados) → la
  línea vuelve al ORIGINAL directo (atajo "quiero esta línea como era").
- **Línea vieja pintada (lado rojo, pareja)** → `restoreOldWords(after,
  before, sels)`: recorre la pareja por REGIONES de cambio a nivel token:
  - toda la palabra-vieja contentiva pintada → **swap**: la región vuelve al
    texto viejo (pintar la roja entera = la línea original);
  - algunas palabras pintadas → vuelven y el reemplazo SE MANTIENE
    ("the quick brown fox"→"the slow fox" con "quick" → "the quick slow fox");
  - media palabra → no restaura (el doble-click pinta palabras enteras).
- **Línea vieja SIN pareja** (borrada entera) → vuelve tal cual (no hay dónde
  splicearle una palabra suelta).
- Roja y verde de la misma pareja pintadas → gana el rojo.

El resultado son las líneas nuevas del archivo → `write_file` con `base` →
conflicto imposible de pasar por arriba (§3) → el panel se auto-refresca
(no esperar al watcher: fs.watch de macOS se come eventos — lección dura).

### 5.4 Ejecución

- Sin modo: popup flotante ＋/↩ junto a la selección (pintada única).
- **Modo brocha** `?`/`↩↩`: acumula N pintadas SIN popups, y el botón del
  toolbar (segundo click) o **Enter** ejecuta TODO en una sola escritura.

## 6. Edición en vivo (✏️)

`Editor` de pierre enganchado al `FileDiff`: cada tecla re-difiera (el editor
mantiene espejos SPAN propios en el shadow, aparte de las filas diff).
Autosave con debounce 900 ms vía `write_file`; ⌘Z/⌘⇧Z nativos; ↩ Descartar
restaura el contenido de antes del ✏️. El refresh reactivo queda en pausa
mientras editás (chip honesto) y se aplica al salir.

**La regla de oro (lección 0.9.9)**: en edición, NINGUNA capa del panel toca
el archivo. El MutationObserver del shadow dispara con cada tecla, y el
colorizador les reescribía filas ENTERAS con tokens del contenido VIEJO
(`fileData.after` no vive-actualiza) encima de las filas vivas del editor —
lo tipado quedaba negro/pisado. Hoy `hlColorize` y el loop del rAF saltan
`entry.edit`, y el e2e lo vigila con `entry._hlRuns` (contador de corridas).

## 7. Syntax highlighting

11 lenguajes bundleados (json, yaml, python, ts/js, markdown, html, css,
bash, kotlin, haskell) con el motor JS de shiki (sin wasm) — el subset entra
en el límite de 4 MiB. El renderer embebido de pierre no cablea tokens en
nuestro contexto, así que el PANEL pinta: `hlColorize` reemplaza el contenido
de la fila ENTERA (`r.innerHTML`) con spans coloreados — reemplazo completo,
no del primer span: los tokens de pierre viven en VARIOS spans hermanos y
escribir solo el primero dejaba los restantes = **texto duplicado** (bug real
de la 0.9.7, invisible al rig hasta que el rig aprendió a asertar texto
EXACTO). Idempotente por tema (`dataset.hl`), re-pintado en expansión de
hunks; en edición no corre (§6). Fuera del subset → plain.

## 8. Colores de las cajas — derivados, nunca fijos

El relleno de las cajas de palabra se calcula PROGRAMÁTICAMENTE desde el
color REAL de la fila del diff (muestreado con `getComputedStyle`; pierre
expone colores en sintaxis moderna — `lab(...)` — así que no se parsean: se
dejan como custom properties y el navegador resuelve):

```css
/* panel.css — la fórmula viva */
background: oklch(from var(--wc-green) min(l + 0.22, 0.75)
                               min(max(c * 1.25, 0.13), 0.24) h / 0.42);
```

Por qué así: sobre un fondo **negro**, un `opacity` solo MEZCLA HACIA NEGRO —
nunca puede brillar. Y un color fijo lavaba el texto en algún tema. La
fórmula mantiene el tono (`h`) del tema real, sube luminosidad/cromo con
topes y pisos (sin piso de cromo, los colores tenues muestreados salen casi
grises), y el alpha deja pasar el 58 % del texto. Una caja **por palabra**
(espacios limpios entre cajas) para que una línea con muchos cambios se siga
leyendo.

## 9. Preguntas ancladas

Hover de línea → ＋ del gutter (o cajitas del gutter para rangos, o ＋ del
head para el archivo) → composer → `app.sendMessage` como mensaje de USUARIO
con `- \`path:line\` (Diff Ask · diff, líneas a-b · side):` + las líneas
citadas verbatim. El header nombra el scope (modo/turno/commit). El skill
(`SKILL.md`) le enseña al modelo a responder SOBRE esas líneas y a fijar
respuestas con `# Code comments:` (tarjetas nativas de la app). Los 💬 del
panel son las preguntas ancladas, colapsadas sobre su línea.

---

## 10. Decisiones de diseño (el por qué, con la historia)

1. **Quirúrgico SIEMPRE.** Pintar borra/restaura exactamente los chars
   pintados. (0.9.1 probó "adición pura → borrar línea entera": a Damian le
   revertía las 3 líneas cuando pintaba 3 palabras — regresión inmediata.)
2. **Diff clásico de dos filas, estilo GitHub** (0.9.11, spec final). El
   camino probó: una fila por línea con la roja oculta (0.9.4) → los
   removidos tachados DENTRO de la fila verde (0.9.8) → ambas descartadas:
   "la línea roja con la palabra en rojo, abajo la verde con la verde".
   La lección: los modelos de una fila optimizan pixels y pierden lectura.
3. **Los gestos nativos mandan** (doble/triple/drag): la selección se comporta
   como en un editor, que es donde vive la mano del usuario.
4. **Offsets contra el archivo, siempre** — y cuando hubo que convivir con
   DOM mezclado (era de los tachados), las conversiones de espacio viven en
   utilidades únicas y testeadas (`mergedOffToNew`, `newRangeToMergedSegs`).
   Hoy quedan como defensa: sin tachados, merged == new.
5. **Parejas roja/verde quirúrgicas en ambos lados** (0.9.14): pintar una
   palabra de la roja la restaura EN SU LUGAR. Antes: pareja atómica (la
   roja pintada = línea entera al original). La atómica sobrevive como caso
   extremo (pintar todo = swap completo) y para rojas sin pareja.
6. **Coexistencia por chars, no por filas**: "se despintaba lo pintado al
   pintar lo nuevo" se arregló midiendo solapamiento de CARACTERES.
7. **El editor ✏️ es territorio de pierre** (0.9.9): capas propias = bugs de
   render sobre filas vivas. Aislamiento total.
8. **Colores muestreados + derivados** (0.9.10–0.9.15): parsear colores a
   mano falló dos veces (regex `rgba?(` no matchea `lab()`, y el canvas ya
   tampoco normaliza). La fórmula oklch relativa es corta, correcta en
   cualquier sintaxis futura, y se adapta sola al tema.
9. **Una caja por palabra**: el word-diff devuelve rangos mergeados; con
   muchas palabras cambiadas el bloque continuo era ilegible. Los espacios
   limpios entre cajas hacen la legibilidad.
10. **Agente gana en conflictos de escritura** + shelve: la política menos
    sorprendente para un humano que edita encima de un agente que trabaja.
11. **Refresh reactivo + auto-refresh tras escribir**: fs.watch de macOS
    pierde eventos justo después de un write propio (visto con 12 shelves
    seguidos); `writeReverted` se refresca solo.
12. **lib.js pura, overlays, idempotencia con firma**: todo lo testeable sin
    browser está en lib; toda decoración es una pasada idempotente con gate
    de firma y sus invariantes ANTES del gate (las invariantes que quedaron
    adentro del gate se saltaban en refresh de contenido idéntico — la roja
    pareada "se duplicaba").

## 11. Límites conocidos

- El e2e puede flamear bajo carga del sistema (timing de CDP) → reintentar.
- `fs.watch` de macOS: el watcher del server puede perder un evento
  (mitigado: firma + auto-refresh post-write; test del watcher es el único
  flaky conocido de unit).
- Highlighting fuera del subset de 11 lenguajes → plain.
- El revert de una roja SIN pareja es atómico por diseño (no hay dónde
  splicear una palabra suelta en una línea que no existe).
- `apply-fixture-mods.mjs` resetea `tests/diffs/` desde HEAD: los cambios
  manuales que tengas ahí se pierden al correr el e2e.
