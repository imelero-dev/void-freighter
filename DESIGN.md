# VOID FREIGHTER — Documento de Diseño (GDD)

Simulador espacial multijugador: comercio, contratos de carga, minería, economía simulada y combate contra piratas. Construido sobre el mismo stack que `world-of-claudecraft`: núcleo de simulación determinista compartido entre offline y online, servidor Node autoritativo, Postgres JSONB, y presentación 100% procedural (sin archivos de assets).

Este documento es la especificación de implementación. Está escrito para ser ejecutado autónomamente de principio a fin.

---

## 1. Pilar de diseño

Un loop económico-espacial en primera/tercera persona donde el jugador pilota una nave de carga, recorre un sistema estelar persistente, y genera dinero por tres vías acoplables:

- **Transporte (contratos):** llevar carga del punto A al B con plazo.
- **Arbitraje (comercio libre):** comprar barato en un mercado, vender caro en otro.
- **Minería:** extraer recursos de asteroides y refinarlos/venderlos.

El dinero compra mejoras de nave (velocidad, casco, escudo, bodega, armas, escáner, drills). El riesgo es el pirata espacial: encuentros de dogfight que, al ganarlos, sueltan recursos y créditos. Todo en un mundo compartido (MMO) con economía viva.

**Fantasía objetivo:** Euro Truck Simulator en el espacio + Elite Dangerous lite + EVE economía, jugable en navegador.

### Tono

Gritty, no glamuroso. No es space-opera limpia ni neón colorido. Es trabajo: una nave de carga usada, instrumentos analógicos, el espacio como un sitio vacío, frío e indiferente. El jugador es un contratista de poca monta, no un héroe. La emoción central no es el poder, es la **vulnerabilidad**: estás solo, lejos, con una nave que se rompe, y cualquier punto rojo en el escáner puede ser el último. La soledad y el miedo de bajo nivel son una feature mecánica y sensorial deliberada, no un efecto secundario. Ver §1bis para el diseño concreto de atmósfera, soledad y tensión.

---

## 1bis. Atmósfera, soledad y tensión (diseño explícito)

**Objetivo de sensación:** el espacio se siente enorme, vacío y peligroso. Volar de un punto a otro debe producir una tensión sorda; llegar a una estación debe sentirse como un alivio. El miedo no viene de jumpscares sino de aislamiento, escasez de información y consecuencias reales.

### Dirección artística (gritty)

- **Paleta apagada:** negros profundos, grises industriales, óxidos, ámbar de instrumentos. Color saturado reservado para señales de peligro (rojo de alarma, naranja de thruster). La estrella ilumina duro y con sombras largas; el lado oscuro de la nave queda casi negro.
- **Estética usada/funcional:** cascos con paneles sucios, rayados, parches; estaciones industriales con luces que parpadean y zonas en penumbra. Nada brilla a estreno.
- **Grano y suciedad de imagen:** ligero grain de film, aberración cromática sutil, viñeteado, scanlines tenues en el HUD, polvo y micro-impactos en el "cristal" de la cabina. Bloom contenido (solo en emisores reales). Todo procedural (post-proceso/shaders), sin texturas de archivo.
- **Cabina (cockpit view) por defecto:** marco de la nave visible, instrumentos analógicos con aguja, retículo proyectado. Refuerza claustrofobia + "estás dentro de una máquina frágil". 3ª persona disponible pero la cabina es la experiencia canónica.
- **Vacío real:** fuera de cinturones y estaciones, el espacio está literalmente vacío. Largos tramos sin nada salvo estrellas lejanas. El vacío es el contenido.

### Soledad (sensación de espacio profundo)

- **Distancias que se sienten:** aunque el crucero acelera el viaje, hay un tiempo mínimo de tránsito perceptible entre destinos (decenas de segundos a minutos), con la estación de destino apareciendo primero como un punto y creciendo lentamente. El destino tarda en llegar a propósito.
- **Silencio activo:** en tránsito, el audio se reduce al zumbido del propio motor, el aire del soporte vital y crujidos del casco. Sin música la mayor parte del tiempo. El silencio es el default; el sonido es información.
- **Radio/comms ambientales:** transmisiones de fondo ocasionales, entrecortadas y a veces inquietantes (otro contratista pidiendo coordenadas, una baliza automática repitiendo, estática, un mensaje cortado a media frase). Refuerzan que hay un mundo ahí fuera y que estás lejos de él. Procedural/sintetizado.
- **Escala visual:** planetas y estaciones renderizados a escala intimidante; tu nave es minúscula al lado. Nebulosas y starfield densos dan profundidad sin poblar el espacio jugable.
- **Soledad real en MMO:** densidad de jugadores baja por diseño en espacio abierto (interés espacial + sistema grande). Encontrarte con otro jugador en el vacío debe ser un evento, no rutina. Las estaciones son los puntos de reunión.

### Tensión y "miedo" (mecánicas que lo producen)

- **Información escasa:** el escáner tiene rango limitado; los contactos aparecen primero como firma sin identificar (blip ambiguo) y solo se resuelven (tipo/facción/hostilidad) al acercarse o con tiempo de escaneo. No sabes si ese punto es un mercante, una roca o un raider hasta que es tarde. Mejor escáner = ver antes = menos miedo (la mejora compra tranquilidad).
- **Recursos finitos en tránsito:** combustible/energía de salto consumible (§ motor). Quedarte sin combustible lejos de una estación es una situación de pánico real (deriva, pedir rescate, perder carga). Esto hace que cada viaje largo se planifique.
- **Daño persistente y reparación cara:** el casco no se autorrepara fuera de estación; un combate te deja tocado y tienes que decidir si sigues a destino dañado o desvías a reparar. Alarma de bajo casco (pulso visual rojo + tono) cuando estás cerca de morir.
- **Consecuencia de muerte:** pierdes la carga (incluida la de contrato). Eso hace que llevar una bodega llena por espacio rojo sea genuinamente estresante: tienes algo que perder.
- **Zonas rojas anunciadas pero no garantizadas:** el mapa marca espacio peligroso, pero los piratas también pueden interceptar en ruta abierta con baja probabilidad creciente según el valor de tu carga. Nunca estás 100% seguro fuera de estación.
- **Audio de amenaza:** detección de firma hostil → tono de alerta grave y creciente; lock-on enemigo → beep acelerado. El sonido avisa del peligro antes que la vista.
- **Encuentros "no-combate" inquietantes (fase 2):** restos de naves a la deriva, balizas de socorro sin respuesta, campos de escombros con loot y riesgo. Premian explorar el vacío pero mantienen la guardia alta.

### Alivio (contrapunto necesario)

La tensión funciona porque hay descompresión: acoplar en estación corta el silencio con ambiente humano (motores, anuncios, multitud lejana), restaura escudo/casco, te hace invulnerable y da acceso a servicios. El contraste vacío-tenso ↔ estación-segura es el latido emocional del juego.

---

## 2. Stack técnico (idéntico al de referencia)

| Capa | Tecnología |
|---|---|
| Cliente render | Three.js (geometría/material procedural, sin GLTF ni texturas externas) |
| Lenguaje | TypeScript (target del repo: ~88% TS) |
| Build | Vite |
| Núcleo de juego | `src/sim/` determinista, sin imports de DOM, compartido por offline y online |
| Servidor | Node autoritativo: HTTP (REST auth) + WebSocket (mundo a 20 Hz) |
| Persistencia | Postgres 16 (Docker), estado de jugador como JSONB |
| Audio | WebAudio sintetizado en runtime, sin archivos |
| Deploy | `docker-compose.yml` (postgres + game server), front con reverse proxy TLS |

**Regla dura:** cero archivos binarios de assets. Naves, planetas, estaciones, asteroides, partículas, UI e iconos se generan con código (geometría Three.js, shaders/materiales, canvas para iconos, WebAudio para sonido). Igual que el proyecto de referencia.

---

## 3. Arquitectura

### 3.1 Núcleo determinista (`src/sim/`)

- Una clase `Sim` que avanza el mundo con `tick(dt)` a paso fijo. Mismo `Sim` corre offline (en el navegador) y dentro del servidor autoritativo.
- Sin `Math.random()` directo: PRNG sembrado (mulberry32/xorshift) con seed del mundo fijo, para que el sistema estelar sea el mismo lugar en cada visita.
- Toda la matemática de física, combate, loot, precios y transacciones vive aquí.

### 3.2 Interfaz IWorld (`src/world_api.ts`)

- Interfaz que satisfacen tanto `Sim` (offline) como `ClientWorld` (online).
- El render y la UI consumen `IWorld`; no saben si están offline u online.

### 3.3 Servidor autoritativo (`server/`)

- El cliente envía a 20 Hz: intención de movimiento (vector de empuje, rotación deseada) + comandos discretos (disparar, minar, comprar, aceptar contrato).
- El servidor corre el `Sim` compartido y emite snapshots con interés espacial (solo entidades dentro de ~radio de sensor del jugador, p.ej. 8–15 km de mundo) + eventos enrutados por jugador.
- Toda transacción económica, daño, roll de loot y crédito de misión se resuelve server-side. El cliente es un renderer + predictor.
- Predicción cliente + reconciliación para el vuelo de la propia nave (interpolación de las demás).

### 3.4 Persistencia

- Cuentas: contraseñas con scrypt, tokens bearer de 7 días, rate-limit por IP (igual al de referencia).
- Perfil de jugador (JSONB): créditos, nave activa, módulos instalados, bodega/inventario, contratos activos, reputación por facción, posición y sistema, estadísticas. Guardado cada 30 s, en logout y en shutdown.
- Estado económico global (precios de mercado, stock por estación) persistido y simulado en el servidor.

---

## 4. Mundo

### 4.1 Topología

- 1 sistema estelar al inicio (escalable a varios vía saltos), generado proceduralmente desde seed fijo.
- Contenido del sistema:
  - 1 estrella central (luz + emisión, partículas de corona).
  - 5–8 planetas en órbitas, cada uno con 1 estación orbital acoplable (dock).
  - 2–4 lunas sin estación (decorativas / futuras).
  - 3–5 cinturones/campos de asteroides con densidad y composición distintas.
  - 1–2 estaciones independientes (hub neutral, mercado negro).
  - Rutas de patrulla y zonas de piratas (espacio "rojo" con spawn de hostiles).

### 4.2 Planetas / estaciones

Cada estación expone servicios (no todos en todas):

- **Mercado** (compra/venta de mercancías) con precios dinámicos.
- **Tablón de contratos** (transporte y misiones).
- **Astillero** (mejoras y reparación de nave).
- **Refinería** (mineral bruto → refinado, con merma).
- **Repostaje** (combustible/energía si se implementa consumible).

Cada estación tiene un perfil económico: produce ciertos bienes (baratos) y demanda otros (caros). Esto crea las rutas de arbitraje.

### 4.3 Escalas

- Unidad de mundo = metros, pero distancias inter-planeta enormes → viaje rápido mediante "supercrucero"/boost de salto sublumínico para no volar 20 minutos en línea recta. Distancia de maniobra (combate, dock, minería) en escala normal.
- Dos modos de vuelo: **maniobra** (precisa, cerca de objetos) y **crucero** (alta velocidad entre puntos, se interrumpe ante masa cercana o ataque).

### 4.4 Navegación / GPS con destino seleccionable

Sistema de rumbo central para la fantasía de "camionero espacial" y para mitigar la desorientación del vacío.

- **Selección de destino:** en el mapa del sistema (M) o en la lista de contactos del escáner, el jugador elige cualquier planeta, estación, cinturón o waypoint y pulsa **Set Destination**. Solo un destino activo a la vez (más una cola opcional de waypoints en fase 2).
- **Ruta trazada:** se calcula una línea de rumbo directa (o multi-salto si hay obstáculos/zonas) hacia el destino. Distancia y ETA mostrados.
- **Marcador holográfico en HUD:** un indicador de destino flota en el espacio (estilo waypoint diegético) con:
  - Distancia restante (km/Mm) en tiempo real.
  - Indicador off-screen: flecha en el borde del retículo apuntando hacia el destino cuando está fuera de cámara (te dice hacia dónde girar). Crítico contra la desorientación en el vacío.
  - ETA estimada según velocidad actual.
- **Asistente de alineación:** al alinear el morro con el rumbo, el marcador se "engancha" (snap visual + tono suave) y se habilita el crucero/salto óptimo hacia ese punto. Desviarte rompe el enganche.
- **Crucero dirigido:** con destino fijado, Shift acelera por el corredor de rumbo; el crucero se autointerrumpe al acercarse a destino, a masa, o bajo ataque (sales a velocidad de maniobra).
- **GPS diegético, no mágico:** el rumbo es información de instrumento (consola de a bordo), encaja con el tono gritty. El alcance del mapa/datos depende del escáner: zonas no escaneadas aparecen como huecos sin etiquetar hasta visitarlas. Esto preserva la sensación de frontera y soledad: no todo el sistema está iluminado desde el inicio.
- **Sin GPS = riesgo:** si un módulo de navegación se daña o el jugador entra en zona sin datos, el marcador se degrada (solo dirección aproximada, sin ETA), aumentando la tensión.

---

## 5. Vuelo y controles

### 5.1 Modelo de vuelo

Arcade-newtoniano: empuje aplica aceleración, hay dampeners de inercia conmutables. Velocidad máxima limitada por módulo de motor. Rotación con torque limitado por giroscopios.

- Vector de empuje 6DOF simplificado a: adelante/atrás, strafe lateral, vertical, más yaw/pitch/roll.
- **Flight Assist on (default):** dampeners frenan deriva, apuntado más fácil.
- **Flight Assist off:** inercia pura para combate avanzado.

### 5.2 Controles (teclado + ratón, layout estilo sim espacial)

| Input | Acción |
|---|---|
| W / S | acelerar / frenar (throttle) |
| A / D | strafe izquierda / derecha |
| R / F | strafe arriba / abajo |
| ratón | pitch / yaw (apuntado) |
| Q / E | roll |
| Shift | crucero / boost de salto |
| X | throttle a cero |
| Z | toggle Flight Assist |
| clic izq. | disparar arma primaria |
| clic der. | arma secundaria / misil |
| Tab | ciclar objetivo más cercano |
| T | targetear lo que apunta el retículo |
| G | desplegar/recoger drill de minería |
| Space | solicitar acoplaje (en rango de estación) |
| M | mapa del sistema |
| N | fijar/limpiar destino del objetivo seleccionado (Set Destination) |
| B | bodega / inventario |
| C | nave (paperdoll de módulos) |
| J | diario de contratos |
| K | mercado (acoplado) |
| L | escáner / contactos |
| Enter | chat |
| Esc | cerrar ventanas / menú |

### 5.3 Acoplaje

Acercarse al puerto de la estación dentro de rango + velocidad baja → Space → secuencia de docking automática (animación de aproximación). Acoplado = acceso a servicios, nave invulnerable, regeneración de escudo/casco.

---

## 6. Loop de juego

```
Acoplar en estación
  ├─ leer mercado y tablón de contratos
  ├─ comprar carga barata / aceptar contrato / reparar / mejorar
  └─ despegar
Volar (crucero) hacia destino
  ├─ posible encuentro pirata → dogfight → loot
  ├─ desvío opcional a cinturón → minar → bodega
  └─ llegar y acoplar en destino
Vender carga / refinar mineral / entregar contrato
  └─ beneficio → reinvertir en mejoras → repetir, rutas más largas y rentables
```

**Progresión emergente:** el jugador empieza con una nave básica y bodega pequeña; va escalando a mejores naves, más bodega, mejores armas y escáneres, accediendo a rutas y cinturones más rentables (y más peligrosos).

---

## 7. Economía simulada

### 7.1 Mercancías (commodities)

Catálogo inicial (categorías → bienes), ~16–24 ítems:

- **Materias primas:** Mineral de Hierro, Mineral de Cobre, Hielo, Silicio, Mineral Raro (platino/iridio), Gas Volátil.
- **Refinados:** Acero, Aleación, Agua, Células de Combustible, Componentes Electrónicos.
- **Bienes de consumo:** Alimentos, Medicinas, Textiles, Electrónica de consumo.
- **Industriales:** Maquinaria, Piezas de Nave, Aleaciones Avanzadas.
- **Ilegales (mercado negro):** Estimulantes, Armas, Artefactos (alta ganancia, riesgo de reputación/registro).

Cada bien tiene: `basePrice`, `volatility`, `legal`, categoría, volumen por unidad (ocupa bodega).

### 7.2 Modelo de precios

Por estación y por bien, precio dinámico en función de oferta/demanda local:

```
price = basePrice * (1 + demandFactor) * (1 - supplyFactor) * stationModifier
```

- Cada estación tiene `production[bien]` (genera stock, baja precio) y `consumption[bien]` (consume stock, sube precio).
- Stock simulado en el servidor: producción/consumo aplicados por tick lento (p.ej. cada N segundos de mundo).
- Las compras/ventas de jugadores mueven el precio (vender mucho de un bien hunde su precio local; comprar mucho lo sube). Slippage por tamaño de orden.
- **Reversión a la media:** los precios tienden lentamente a su equilibrio, recuperándose tras shocks. Esto garantiza que las rutas de arbitraje se regeneren.
- Ruido determinista por seed para fluctuaciones (no `Math.random` libre).

### 7.3 Eventos económicos

Eventos periódicos que crean oportunidad/riesgo:

- **Escasez** (sube demanda de un bien en una estación) → premium de venta.
- **Excedente** (baja precio) → oportunidad de compra.
- **Bloqueo pirata** de una ruta → sube precio de bienes que pasan por ahí.
- **Boom industrial** → demanda de maquinaria/piezas.

Eventos anunciados en el tablón/feed de noticias de cada estación.

---

## 8. Comercio

- Acoplado → ventana de Mercado (K): lista de bienes con precio compra/venta, stock disponible, y comparativa de "mejor precio conocido" si el jugador lo ha visto (datos de mercado se desbloquean al visitar / con módulo de datos).
- Comprar = créditos→bodega; vender = bodega→créditos. Validación server-side de espacio de bodega y stock de estación.
- **Bodega:** capacidad en m³ (volumen). Cada bien ocupa volumen; mejorar bodega aumenta capacidad.
- **Galería de rutas:** la UI sugiere spreads (diferencia de precio entre estaciones visitadas) para el bien seleccionado.

---

## 9. Contratos / misiones

Generados proceduralmente en el tablón de cada estación. Tipos:

| Tipo | Descripción | Recompensa |
|---|---|---|
| Transporte | Llevar X unidades de un bien (entregado, ocupa bodega) a estación Y antes de deadline. | Créditos fijos + reputación |
| Entrega urgente | Igual pero con plazo corto y bonus por tiempo. | Créditos altos |
| Suministro de minería | Entregar N unidades de un mineral concreto (lo consigues minando o comprando). | Créditos + reputación |
| Caza/recompensa | Destruir M piratas en una zona. | Créditos + loot |
| Escolta/patrulla (fase 2) | Sobrevivir/limpiar una ruta. | Créditos |

**Mecánica:**

- Aceptar contrato reserva espacio de bodega (la carga de transporte es untradeable y se pierde si destruyen la nave).
- `deadline` en tiempo de mundo; fallar = penalización de reputación, sin penalización de créditos por defecto.
- Entrega validada server-side al acoplar en destino con la carga.
- **Reputación por facción:** cada estación pertenece a una facción; cumplir contratos sube reputación → desbloquea contratos mejores, descuentos en astillero, acceso a zonas restringidas. Contrabando/piratería baja reputación con facciones legales y la sube con piratas.

---

## 10. Minería

### 10.1 Asteroides

- Campos de asteroides con N rocas instanciadas (geometría procedural deformada por ruido, LOD por distancia).
- Cada asteroide tiene composición (% de minerales) y hp/yield (cantidad total extraíble).
- Tipos de roca: rocosa (hierro/silicio), metálica (cobre/raros), helada (hielo/volátiles), rara (platino — spawn escaso, marcado por escáner avanzado).

### 10.2 Ciclo de minería

1. Apuntar asteroide en rango, G despliega mining laser/drill.
2. Mantener haz sobre la roca: barra de extracción; daña la roca y emite fragmentos.
3. Fragmentos flotantes se recogen por proximidad (colector) → mineral bruto a bodega.
4. Roca agotada (hp→0) se fractura/desaparece; respawn del campo en timer.

Velocidad de extracción y rango dependen del módulo de drill. El escáner revela composición y % antes de minar.

### 10.3 Refinado

Mineral bruto ocupa más volumen y vale menos; refinería (estación) convierte bruto→refinado con merma (p.ej. 70–90% según módulo/skill) y un coste/tiempo. Refinado vende mejor.

---

## 11. Combate / dogfights / piratas

### 11.1 Stats de combate de la nave

- `hull` (casco, integridad física; 0 = destrucción).
- `shield` (escudo regenerativo; absorbe antes que el casco; se recarga tras X s sin recibir daño).
- `power` (energía repartible entre motores/armas/escudos — pips, opcional fase 2).
- Armas: primaria (cañones de energía/balística, hitscan o proyectil rápido, DPS sostenido) y secundaria (misiles con lock-on, daño alto, munición limitada).

### 11.2 Modelo de daño

```
si shield > 0:  daño aplica a shield (con resistencia de escudo)
si shield == 0: daño aplica a hull (con resistencia de blindaje)
```

Crítico por golpe en punto débil (opcional). Daño por colisión a alta velocidad. Todo el cálculo de daño/loot es server-side y autoritativo.

### 11.3 IA de piratas

- Spawn en zonas rojas y en ruta (probabilidad por crucero a través de espacio peligroso, mayor si llevas carga valiosa).
- Estados de IA: patrulla → detección (por sensor/firma de la nave) → aproximación → ataque (persecución, strafe, mantener distancia óptima de arma) → huida si hull bajo.
- Niveles de pirata (scout, fighter, raider, capitán élite) con escalado de hull/escudo/daño y mejor loot. Capitanes con habilidad especial (volley de misiles, drones).

### 11.4 Loot

- Al destruir un pirata: explosión + contenedores de loot flotantes → recoger por proximidad.
- Drops: créditos, mercancías (incl. ilegales), minerales, ocasionalmente módulos de nave (rare/blue). Tablas de loot ponderadas por nivel de pirata, rolls server-side.

### 11.5 Muerte del jugador

`hull→0` = nave destruida. Penalización: se pierde la carga no asegurada (incl. carga de contrato), respawn en la última estación donde se acopló con la nave básica de reemplazo (o seguro si se implementa). Sin pérdida de nivel/reputación. Modelo no-hardcore por defecto.

---

## 12. Progresión y mejoras de nave

### 12.1 Naves (hulls)

Varios chasis comprables en astillero, con trade-offs:

| Nave | Rol | Bodega | Vel/Maniobra | Casco/Escudo | Slots |
|---|---|---|---|---|---|
| Shuttle (inicial) | starter | baja | media | bajo | pocos |
| Hauler | carguero | alta | baja | medio | medios |
| Prospector | minería | media | media | medio | drill+ |
| Interceptor | combate | baja | alta | alto | armas+ |
| Freighter | carga pesada | muy alta | muy baja | alto | muchos |

### 12.2 Módulos (slots)

Cada nave tiene slots tipados. Módulos por tier (1→5):

- **Motor** (velocidad máx + aceleración)
- **Giroscopios** (maniobra/torque)
- **Generador de escudo** (capacidad + regen)
- **Blindaje** (hull + resistencia)
- **Bodega** (capacidad m³)
- **Arma primaria / secundaria**
- **Drill de minería** (velocidad/rango extracción)
- **Colector** (radio de recogida)
- **Escáner** (rango de sensor, datos de composición y mercado)
- **Computadora de salto / combustible** (alcance de crucero; el salto consume combustible — quedarse sin reservas lejos de estación es una situación crítica)
- **Computadora de navegación / GPS** (calidad del marcador de destino, ETA, rango de datos de mapa; degrada si se daña)

Comprar/instalar/vender módulos en astillero. Reparación de hull/escudo por créditos. Todo persiste en el perfil JSONB.

### 12.3 Curva económica

Diseñar costes para que el tiempo-a-siguiente-mejora sea satisfactorio: starter→hauler asequible en pocas rutas; naves tope requieren minería+combate+arbitraje combinados. Números concretos: el implementador fija `basePrice`, recompensas de contrato y precios de módulos para una curva suave (sin grind extremo ni trivial).

---

## 13. Multijugador / MMO

- Mundo compartido autoritativo; jugadores se ven en el espacio y en estaciones.
- Snapshots con interés espacial (solo entidades dentro del rango de sensor).
- Chat (`/say` local por proximidad, global de estación).
- Economía compartida: las órdenes de todos los jugadores mueven los mismos precios → mercado vivo real.
- Combate PvP opcional en zonas no vigiladas (espacio rojo); estaciones y espacio vigilado = no-PvP (torretas de defensa destruyen agresores).
- Wings/escuadrón (fase 2): grupo hasta 4, comparten crédito de caza, blips aliados en escáner.
- Reglas anti-griefing: respawn seguro, carga de contrato no robable directamente (se pierde al morir, no se transfiere), espacio seguro alrededor de estaciones.

---

## 14. UI / HUD (clásico de sim espacial, procedural)

- **HUD de vuelo:** retículo de apuntado, indicador de throttle, velocímetro, barras de hull/escudo, brújula/heading, indicador de objetivo (distancia, hull/escudo del target, nombre/facción), marcador de destino GPS (distancia, ETA, flecha off-screen al borde del retículo).
- **Escáner/radar 3D** (esfera de contactos) o minimapa orbital con blips por tipo (verde aliado, rojo hostil, amarillo neutral, azul estación/asteroide). Los contactos lejanos aparecen como firmas sin identificar (blip gris ambiguo) hasta resolverse por proximidad/tiempo de escaneo — refuerza la tensión.
- **Mapa del sistema (M):** planetas, estaciones, cinturones, ruta seleccionada, Set Destination; zonas no escaneadas en hueco/sin etiqueta hasta visitarlas.
- **Ventanas acopladas:** Mercado, Tablón de Contratos, Astillero (paperdoll de módulos), Refinería.
- **Bodega/Inventario (B):** lista de bienes, volumen ocupado/total.
- **Diario de contratos (J):** activos, progreso, deadlines.
- **Iconos procedurales:** cada bien, módulo y arma con icono dibujado en canvas en runtime (sin archivos), estilo del proyecto de referencia.
- Tooltips con borde, texto de combate flotante (daño), log de combate, feed de noticias económicas.

---

## 15. Presentación procedural

- **Estrella:** esfera emisiva + glow + partículas de corona, luz direccional principal.
- **Planetas:** esferas con material procedural (ruido para continentes/gas/hielo según tipo), atmósfera (halo), anillos opcionales, rotación.
- **Estaciones:** geometría modular (anillos, módulos cilíndricos, brazos de dock, luces parpadeantes), procedural por seed.
- **Asteroides:** icosfera deformada por ruido, variación por tipo, instanciado para campos densos.
- **Naves:** chasis low-poly procedurales por clase (fuselaje, alas, motores con glow de thruster), animación de thrusters según empuje.
- **Efectos:** partículas de mining beam, fragmentos, explosiones, impactos de láser/escudo (flash), estelas de motor, polvo de campo de asteroides, nebulosas (skybox procedural / starfield).
- Sombras y luces dinámicas (thrusters, disparos, estación).
- **Audio WebAudio sintetizado:** zumbido de motor (modulado por throttle), láser, impacto en escudo/casco, explosión, alarma de bajo hull, lock-on de misil, clic de UI, "ka-ching" de venta, fanfarria de contrato completado, ambiente de estación. Sin archivos de audio.
- **Post-proceso gritty** (shaders, sin assets): film grain, viñeteado, aberración cromática sutil, bloom contenido en emisores, scanlines tenues y polvo/micro-impactos en el cristal de cabina. Paleta apagada con tone-mapping de alto contraste.
- **Audio de soledad y amenaza:** default silencioso en tránsito (motor + soporte vital + crujidos de casco); música casi ausente. Comms ambientales entrecortados/inquietantes sintetizados. Tono de alerta grave creciente al detectar firma hostil; beep acelerado en lock-on enemigo. Contraste sonoro al acoplar (ambiente humano de estación) como descompresión.

---

## 16. Esquema de datos (Postgres)

- `accounts` (id, email/usuario, scrypt hash, created_at)
- `auth_tokens` (token, account_id, expires_at) — 7 días
- `players` (account_id, JSONB state):

```jsonc
{
  "credits": 0,
  "ship": { "hull": "shuttle", "modules": { "engine": 1, "shield": 1 }, "hp": {} },
  "cargo": [ { "good": "iron_ore", "qty": 12 } ],
  "contracts": [ { "id": "...", "type": "transport", "good": "...", "qty": 10, "dest": "...", "deadline": 0 } ],
  "reputation": { "faction_a": 0, "pirates": 0 },
  "location": { "system": "sol_seed", "station": "...", "pos": [0, 0, 0] },
  "knownMarkets": { "stationId": { "good": 0 } },
  "stats": { "kills": 0, "tonsHauled": 0, "minedUnits": 0 }
}
```

- `market_state` (JSONB por estación: stock y precio actual de cada bien) — simulado y persistido server-side.
- Nombres de jugador globalmente únicos. Guardado cada 30 s / logout / shutdown.

---

## 17. Estructura de carpetas (espejo del repo de referencia)

```
src/sim/        # núcleo determinista: física de vuelo, economía, combate, minería, IA pirata, loot. SIN DOM.
src/render/     # Three.js: ships.ts (chasis), bodies.ts (planetas/estrella/estación), asteroids.ts, fx.ts, textures.ts (procedural), starfield.ts
src/game/       # input + cámara (cockpit/3ra persona) + WebAudio synth
src/ui/         # HUD vuelo, radar, mapa sistema, mercado, contratos, astillero, bodega, tooltips, iconos canvas
src/net/        # cliente online: REST auth + WebSocket (ClientWorld)
src/world_api.ts# interfaz IWorld que cumplen Sim y ClientWorld
server/         # main.ts (HTTP+WS), game.ts (loop de mundo + economía), db.ts, auth.ts
docker-compose.yml  # postgres:16-alpine + game server
tests/          # vitest: física, economía/precios, combate, minería, contratos, IA pirata, persistencia, multiplayer
scripts/        # E2E navegador, tour de screenshots, integración multijugador, bots de prueba
```

- Seed del mundo fijo en `src/main.ts` → el sistema estelar es el mismo lugar en cada visita.
- Modo offline (Play Offline) corre el `Sim` en el navegador; modo online conecta al servidor. Mismo render/UI vía `IWorld`.

---

## 18. Tests (vitest + E2E navegador, como referencia)

- **Unitarios sim:** integración de física de vuelo determinista; modelo de precios (oferta/demanda, reversión a la media, slippage); resolución de daño (escudo→casco); rolls de loot; extracción de minería; generación y validación de contratos.
- **Económicos:** una orden grande mueve el precio; el precio revierte; arbitraje rentable existe pero se erosiona con volumen.
- **Combate:** dogfight bot vs pirata; muerte y respawn; pérdida de carga.
- **Multiplayer/persistencia:** suite de checks API/WS, dos clientes de navegador se ven en el espacio, persistencia JSONB tras logout/login, transacción de mercado autoritativa concurrente (sin duplicación de créditos/stock).
- **Scripts:** `smoke_trade.mjs` (comprar barato → vender caro → beneficio), `smoke_mine.mjs` (minar → refinar → vender), `smoke_combat.mjs` (matar pirata → loot → bodega), `visual_tour.mjs` (screenshots de sistema, estación, cinturón, dogfight, mercado).

---

## 19. Hitos de implementación

1. **Núcleo de vuelo + render:** Sim con física de nave, cámara, controles, un planeta + una estación, starfield. Acoplaje básico.
2. **Mercado + bodega:** commodities, precios estáticos→dinámicos, comprar/vender, volumen de bodega. Loop de arbitraje jugable offline.
3. **Sistema completo:** 5–8 planetas/estaciones con perfiles económicos, mapa del sistema, crucero/salto, viaje punto a punto.
4. **Minería:** campos de asteroides, drill, fragmentos, refinería.
5. **Combate + piratas:** armas, escudo/casco, IA pirata, loot, zonas rojas, muerte/respawn.
6. **Contratos + reputación:** tablón procedural, transporte/caza/suministro, deadlines, facciones.
7. **Mejoras de nave:** astillero, naves múltiples, módulos por tier, reparación.
8. **Multijugador autoritativo:** servidor + Postgres + auth, snapshots por interés, economía compartida, chat, ver otros jugadores.
9. **Pulido:** FX, audio procedural, balance de curva económica, eventos económicos, anti-griefing, tests E2E completos.

Cada hito debe quedar jugable y testeado antes del siguiente. Offline funcional en todo momento; el online se monta sobre el mismo `Sim`.

---

## 20. Deploy

- `docker compose up -d --build` → postgres + game server.
- Front del puerto del servidor con reverse proxy TLS (WebSocket proxeado; cliente auto-selecciona `wss://` en https).
- Auth rate-limited por IP, contraseñas scrypt, tokens 7 días. Flag de comandos dev (teleport/credits) solo para bots de test, nunca en producción.

---

## 21. Notas para el ejecutor

- Implementa de principio a fin siguiendo los hitos. Mantén el `Sim` determinista y sin DOM. Cero archivos de assets: todo procedural.
- Fija los números de balance (precios base, recompensas, costes de módulos, hull/escudo, yields de minería, tablas de loot) tú mismo para una curva de progresión fluida; documenta los valores elegidos en `docs/design/`.
- Nombres de sistema, planetas, estaciones, facciones y bienes: originales, generados con coherencia temática.
- Entrega con README de hosting (espejo del de referencia), suite de tests verde, y tour de screenshots.
