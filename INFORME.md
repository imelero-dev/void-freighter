# Informe de preparación — publicación del modo offline

Fecha: 2026-10-17 · Rama: `mejoras-claude` · Sin remoto, sin push.

## 1. Instalación, typecheck y tests

| Paso | Resultado |
|---|---|
| `npm install` | OK (109 paquetes, ya al día). `npm audit`: 9 vulnerabilidades (3 moderate, 4 high, 2 critical) en dependencias de desarrollo/build: `vitest`/`@vitest/mocker`/`tinypool`, `esbuild` anidado de vitest, `nanoid`, `postcss`, `source-map-js`. |
| `npm run typecheck` | OK, sin errores. |
| `npm test` | OK: 7 ficheros, **70/70 tests** en verde (~8 s). |

No había fallos reales que corregir en el código. **No** he ejecutado
`npm audit fix`: parte de los arreglos exige `--force` (subida mayor de vitest)
y eso no es un cambio pequeño. Las vulnerabilidades afectan a herramientas de
desarrollo, no al bundle estático publicado; conviene que el dueño las revise.

## 2. Comandos dev y ficheros de despliegue

**`ALLOW_DEV_COMMANDS` está apagado por defecto.** El servidor solo los acepta
si la variable vale exactamente `'1'`; sin la variable, los mensajes se ignoran.

Dónde están (no se han borrado; decisión del dueño):

- `server/game.ts:231-257` — `dev_credits`, `dev_teleport`, `dev_give`, cada
  uno protegido por `process.env.ALLOW_DEV_COMMANDS === '1'`.
- `tests/server.test.ts:9` — los tests la activan (`'1'`).
- `scripts/online_tour.mjs:54` — el tour online la activa para su servidor local.
- `.env.example:9` — línea comentada con aviso "NEVER in production".
- `README.md` (sección del servidor) — documentada con el mismo aviso.

Relacionado (modo offline/cliente): `src/main.ts:51` expone
`window.VF = { world, vec }` "para scripts E2E/bots". En el build estático
permite manipular la partida desde la consola del navegador. En modo offline
(un jugador, guardado en localStorage) es inofensivo; en online el servidor es
autoritativo. Se deja tal cual; anotar por si el dueño prefiere ocultarlo.

Ficheros de despliegue:

- `.env.example`: solo valores de ejemplo (`POSTGRES_PASSWORD=change-me`,
  `DATABASE_URL` comentada con `password` literal). Sin valores reales.
- `Dockerfile`: no contiene secretos ni variables sensibles; no copia `.env`.
- `docker-compose.yml`: la contraseña viene de `${POSTGRES_PASSWORD:?...}`
  (falla si no se define); puertos solo en `127.0.0.1`. No define
  `ALLOW_DEV_COMMANDS`. Sin valores reales.
- `.gitignore` excluye `.env`, `node_modules/`, `dist/`, `dist-server/`.
  No existe ningún `.env` en el árbol.

## 3. Barrido de secretos y datos personales

Revisado todo el árbol (excepto `node_modules/`, `dist/`, `.git/` y
`package-lock.json`, que solo contiene URLs del registro npm).

| Tipo | Hallazgo |
|---|---|
| Claves API / tokens / claves privadas | Ninguno (`sk-`, `ghp_`, `AKIA`, `xox*`, `BEGIN … KEY`, etc.). |
| Contraseñas | Solo de prueba: `secret1`/`wrong`/`123` en `tests/server.test.ts:98-203` y `scripts/online_tour.mjs:41`; `change-me` y `password` de ejemplo en `.env.example:4,8`. Ninguna real. |
| Emails | Ninguno en ficheros. **En el historial git**: autor/committer `Aitor <aitor@local>` (commit `6e215f4`). Si el repo se publica con historial, ese nombre será visible. |
| Teléfonos | Ninguno. |
| Rutas personales (`/home/…`, `/Users/…`, `C:\…`) | Ninguna. Los scripts de capturas buscan Chromium con `homedir()` + `.cache/ms-playwright` y rutas de sistema genéricas (`scripts/visual_tour.mjs:18-35`, igual en `playtest_journey.mjs` y `online_tour.mjs`); no es una ruta personal fija. |
| URLs | Solo `localhost` y `game.example.com` (ejemplo de Caddy). |
| Nombres de usuario en datos | Usuarios ficticios de tests/bots: `pilot_one`, `alice_haul`, `bob_mining`, `tour_alice`, `tour_bob`, `TourBot`, etc. |
| Otras menciones | `README.md` y `DESIGN.md:3` citan el proyecto `world-of-claudecraft` como stack de referencia, sin enlace. No es un secreto, pero es una referencia que el público no podrá seguir; el dueño decide si la mantiene. |

## 4. Cambios en README.md

- Corregido "The repo contains zero binary assets": el juego no carga assets
  binarios, pero el repo sí incluye 14 PNG en `screenshots/`.
- Aclarado que la demo pública es el modo offline y que el multijugador es
  solo autoalojable (no hay servidor oficial).
- Corregido el Quick start: decía "hold Shift to cruise", pero Shift es
  acelerar (`src/game/input.ts:153`) y el crucero es Caps Lock
  (`src/ui/keybinds.ts:20`), como ya decía la tabla de controles.
- Corregido el número de tests: "51 vitest specs" → 70 tests.
- Nueva sección para publicar el build offline como sitio estático.
- Licencia apunta a `LICENSE`; añadida sección "Feedback" para issues.
- Marcadores pendientes: `[ENLACE]` (URL de la demo), `[ENLACE]` (URL de
  issues), `[CAPTURA]` (captura o GIF adicional, si se quiere).
- Nota: la imagen principal `screenshots/05_cruise.png` **no muestra el modo
  crucero** (aparece "Cruise drive: mass-locked" a 10 m/s junto a la estación).
  `10_journey_arrival.png` sí muestra crucero (7098 m/s, CRUISE). No la he
  cambiado; lo decide el dueño.

## 5. Build estática del modo offline

- `npm run build` → OK en ~1,4 s. Salida en `dist/`: `index.html` (15 kB) y
  `assets/` (`index-*.js` 710 kB / 193 kB gzip, `client_world-*.js` 11 kB,
  cargado solo al entrar en online). Sin otros ficheros.
- `vite.config.ts` usa `base: './'`: rutas relativas, vale para cualquier
  hosting estático o subcarpeta (p. ej. GitHub Pages).
- **Verificado**: servido con `python3 -m http.server --directory dist` y
  abierto en Chrome headless (`puppeteer-core` del proyecto): carga sin
  errores de consola ni peticiones fallidas, LAUNCH arranca el modo offline y
  aparece la estación (Market de Morrow Granary).
- No verificado en esta sesión: `npm run preview` (puerto 4173 por defecto
  de Vite); debería funcionar igual.
- El panel ONLINE en un hosting estático fallará al pulsar LOG IN/REGISTER
  (llama a `/api/...` en el mismo origen). No rompe el modo offline.

Cómo publicarlo:

```bash
npm ci
npm run build
# subir el contenido de dist/ a cualquier hosting estático
# prueba local:
python3 -m http.server 8080 --directory dist   # http://localhost:8080
```

## 6. Capturas (`screenshots/`)

Revisadas visualmente las 14. **Ninguna muestra rutas de sistema, nombres de
usuario reales, barras del navegador ni escritorio**: todas son la ventana del
juego a 1280×800.

| Fichero | Contenido | ¿Rutas / usuarios? |
|---|---|---|
| 01_menu.png | Menú principal | No |
| 02_docked_station.png | Market en Morrow Granary | No |
| 03_space_undocked.png | Espacio tras desatracar | No |
| 03b_station_exterior.png | Exterior de la estación | No |
| 04_flying.png | Vuelo a 112 m/s | No |
| 05_cruise.png | Junto a la estación, "mass-locked" (ver punto 4) | No |
| 06_map.png | Carta del sistema Vesper | No |
| 07_ship.png | Ventana de nave y módulos | No |
| 08_chase_camera.png | Cámara exterior | No |
| 09_online_two_clients.png | Online; aparecen los bots `tour_alice` / `tour_bob` (ficticios) | Solo nombres de bot |
| 10_journey_arrival.png | Crucero hacia Cinder Forge | No |
| 11_journey_delivered.png | Contrato entregado | No |
| 12_asteroid_field.png | Campo de asteroides | No |
| 13_dogfight.png | Combate con pirata | No |

No he podido comprobar del todo si los PNG llevan metadatos de texto
(tEXt/iTXt/EXIF): la búsqueda no encontró nada, pero no es concluyente con
ficheros binarios. Se generan con Chrome headless (`page.screenshot`), que
normalmente no añade metadatos.
