# Testing de Diff Ask

La pirámide, con tiempos reales, cómo funciona el rig e2e por dentro, y los
pozos que fuimos aprendiendo (para no volver a caer). Para la arquitectura,
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Resumen

| Nivel | Archivos | Qué cubre | Cantidad | Tiempo (M1, mid-load) |
|---|---|---|---|---|
| Unit (lib pura) | `tests/lib.test.mjs`, `lib-frag`, `lib-merge` | tokenizadores, word-diff LCS, `revertLines`/`revertFrags`/`surgeryLine`/`restoreOldWords`, cortes de espacio, `wordRanges` | 80 en total | **~7 s** |
| Unit (server MCP) | `tests/server-*.test.mjs` | modos del diff, turns 📸, `write_file` + conflictos/shelve, parseo — con repos git REALES en tmp | ↑ | ↑ |
| Integración | `tests/revert-integration.test.mjs` | lib → `writeFileGuarded` → `git diff` cierra el circuito en un repo tmp real | ↑ | ↑ |
| E2E | `tests/e2e/revert.e2e.mjs` | el panel REAL (`dist/panel.html`) + server REAL, **mouse y teclado reales** por CDP, cada revert verificado contra git | **86 checks** | **~1 min** |

```bash
npm test          # 80/80 en ~7 s
npm run test:e2e  # 86/86 en ~50–60 s (requiere Google Chrome instalado)
```

## Por qué esta forma

- **La lógica pura no sabe que existe un browser.** Todo el álgebra del revert
  (offsets, cirugía de chars, restauración por regiones, reglas de espacios)
  vive en `lib.js` sin DOM — por eso 80 tests corren en 7 segundos y cada caso
  límite ("doble espacio", "media palabra", "letra suelta") es un test con
  assert de texto exacto, sin timing ni layout.
- **El e2e existe porque la mitad de los bugs de este plugin fueron de
  integración real**: hit-testing del shadow DOM, retargeting de
  `caretRangeFromPoint`, selección nativa vs selectionchange múltiples, el
  layout del componente, el refresh reactivo tras escribir. Nada de eso se
  puede simular honestamente — el rig usa el mismo pipeline de input que el
  mouse del usuario (`Input.dispatchMouseEvent` de CDP).

## El rig e2e por dentro

```
revert.e2e.mjs
 ├─ apply-fixture-mods.mjs     resetea tests/diffs/ desde HEAD + 22 edits
 │                             determinísticos (palabras marcadoras únicas:
 │                             alpha, bravo, charlie, delta, echo, foxtrot)
 ├─ spawn server/server.mjs    el MCP REAL por stdio (ZCODE_WORKSPACE_ROOT=repo)
 ├─ harness http (127.0.0.1)   sirve dist/panel.html + inyecta el modo test:
 │     __DA_TEST__  = fixture + workspace
 │     __DA_E2E__   = puente: fetch /mcp → stdio del server; SSE /events
 │                    → resources/updated (la reactividad REAL)
 │     __DA_HL_READY = stub del highlighter (hlColorize corre su pipeline)
 └─ Chrome headless REAL       --remote-debugging-port por CDP; mouse/teclado
                                con Input.dispatchMouseEvent/KeyEvent
```

Helpers clave del rig (inyectados como `__E2E.*`):
- `locate(rel, needle, type?, noScroll?)` — encuentra la fila, scrollea,
  **espera el settle del scroll**, mide el needle con Ranges reales y devuelve
  per-char rects. Salta filas ocultas (rect degenerado) y resuelve needles
  que terminan al final de la fila.
- `rowAt(rel, x, y)` — ¿qué fila hay REALMENTE bajo un punto? (diagnóstico de
  puntería: `shadowRoot.elementFromPoint`).
- `frags(rel)` / `allFrags()` — lo pintado, con texto y offsets.
- `head(rel)` — header del archivo: scrollea al CENTRO (con `block:"start"`
  queda bajo la modebar sticky y el click se pierde), espera settle, apunta
  al chevron.

Las secciones (A–O) siguen los gestos de Damian: doble-click palabra,
triple-click línea, drag izq→der / der→izq / UNA letra, cajitas del gutter,
Enter, modo brocha con rollback general, coexistencia, drag lento de 1,7 s,
palabra gemela, diff clásico dos filas + cajas por palabra + orden del
toolbar, texto EXACTO tras colorizar y refresh, y edición ✏️ con teclado real
(insertText + Backspace + autosave verificado en disco).

**Cada revert se verifica leyendo el archivo en disco** (y el estado del
panel tras su refresh reactivo) — nunca confiamos en el estado del DOM solo.

### Popurrí para prueba manual

`node tests/e2e/apply-fixture-rich.mjs` — 42 edits bien diversos
(multi-palabra, mixtas, intra-palabra, gemelas) para probar a mano. El e2e
siempre parte del fixture estándar (se resetea solo al arrancar).

## Política de flakes (léelo antes de renegar)

- **El e2e es sensible a la carga del sistema**: input por CDP + sleeps
  fijos + refresh reactivo. Con load alto (>3) pueden fallar 2–6 checks en
  secciones DISTINTAS entre corridas — **reintentar** antes de investigar. Si
  falla LO MISMO dos veces seguidas, ahí sí hay bug (así encontramos todos).
- El test del watcher (`fs.watch` de macOS) es el único flake conocido de
  unit — mismo tratamiento.
- **Nunca empeorar una aserción para que pase**: los checks de texto usan
  EXACTO (`textContent ===`), no subcadenas — un bug de duplicación de texto
  pasó inadvertido semanas porque las aserciones eran por `includes`.
- Gestos del rig: arrancar drags DENTRO de caracteres, no en bordes/tierra
  de nadie entre palabras (bajo load no seleccionan); el punto de un click
  debe medirse DESPUÉS de que el scroll se asiente.

## Pozos aprendidos (el índice del dolor)

1. `caretRangeFromPoint` RETARGEA al shadow host — inservible. Hit-testing
   geométrico con `shadowRoot.elementFromPoint` + búsqueda binaria sobre
   rects de Ranges.
2. Un mismo gesto dispara VARIAS `selectionchange` — sin lock por gesto, la
   segunda despintaba lo que la primera pintó.
3. `fs.watch` de macOS se come eventos justo después de un write propio →
   el panel se auto-refresca tras escribir (no esperar al watcher).
4. pierre expone colores en `lab()`; parsear colores a mano falla (regex,
   canvas). Usar `color-mix`/oklch relativo y que el navegador resuelva.
5. El renderer de pierre pinta tokens en VARIOS spans hermanos — escribir la
   línea en el primero duplica el texto (el rig lo cazó cuando aprendió a
   asertar texto exacto; el stub del highlighter también debe CARGAR de
   verdad — un `\n` literal rompía el script inyectado en silencio).
6. En edición ✏️, ninguna capa del panel toca el archivo: el MutationObserver
   dispara por tecla y el colorizador pisaba filas vivas con tokens viejos
   ("lo tipado se pone negro"). El e2e vigila con `entry._hlRuns`.
7. La roja pareada oculta vive ANTES en el DOM y matchea needles: filtrar
   `getComputedStyle(r).display !== "none"` al buscar filas.
8. `installed_plugins.json` es el registro que decide qué versión se sirve:
   actualizar solo el cache sin el registro (o al revés) = "sigue la vieja".

## Instalación de una versión nueva (la cadena completa)

```bash
npm run build                     # 1) bundle nuevo
# 2) copia del marketplace (de acá reinstala la app):
rsync -a --delete --exclude node_modules diff-ask/ \
  ~/.zcode/cli/plugins/marketplaces/dev-zcode-diff-ask-<id>/diff-ask/
cp marketplace.json ~/.zcode/cli/plugins/marketplaces/dev-zcode-diff-ask-<id>/
# 3) cache por versión (lo que SE SIRVE):
mkdir -p ~/.zcode/cli/plugins/cache/dev-zcode-diff-ask-<id>/diff-ask/<versión>/
rsync -a --delete --exclude node_modules diff-ask/ …/diff-ask/<versión>/
# 4) registro (CON BACKUP): version + installPath del entry diff-ask@dev-…
cp ~/.zcode/cli/plugins/installed_plugins.json ~/.zcode/cli/plugins/installed_plugins.json.bak
# …y editar el JSON (version, installPath, updatedAt)
# 5) reiniciar ZCode (el panel se sirve del cache al arrancar).
```

Alternativa por UI: bump de versión en `plugin.json` + `marketplace.json` →
`npm run build` → ZCode → Personal → dev-… → Update. Reiniciar igual.
