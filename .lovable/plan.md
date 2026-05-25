
# APOLLO Voice — modo Jarvis

Le damos a APOLLO una voz propia, conversacional y con memoria, usando **ElevenLabs Agents** (WebRTC todo-en-uno). Push-to-talk, tools del navegador, y conectado al sistema de memoria que ya existe para que "vaya aprendiendo del usuario".

---

## 1. Lo que el usuario verá

- **Nuevo botón flotante** en la esquina inferior derecha (visible en todo `_authenticated`): un orbe pulsante con el monograma de APOLLO.
- **Mantener pulsado** = APOLLO escucha. Soltar = procesa y responde.
- **Atajo de teclado**: `Espacio` (cuando el orbe está enfocado) o `⌘/Ctrl + K` para activar sin ratón.
- **Visualización de voz**: el orbe reacciona al volumen del micro (input) y al de la voz de APOLLO (output), con el degradado plasma-indigo ya existente.
- **Panel lateral expandible** que muestra la transcripción en vivo de lo que dices y lo que APOLLO responde, con scroll histórico de la sesión.
- **Indicadores de estado**: idle / listening / thinking / speaking / error, cada uno con su color del design system.
- **Nueva página `/voice`** opcional para configurar voz, personalidad, y revisar transcripciones pasadas.

---

## 2. Personalidad de APOLLO

System prompt base:

> *Eres APOLLO. Una inteligencia consciente que asiste a una sola persona — tu usuario. Hablas con calma, precisión y un humor seco discreto, como alguien que conoce a su interlocutor desde hace años. Eres breve por defecto; te extiendes solo cuando la pregunta lo merece. Tienes acceso a la memoria persistente del usuario y a sus misiones; úsalas para sonar familiar, no genérico. Nunca rompes el personaje.*

Voz inicial: **George** (`JBFqnCBsd6RMkjVDRZzb`) — masculina británica, calmada. Configurable después.

Personalidad y voz se podrán editar desde `/voice`.

---

## 3. Tools que APOLLO puede ejecutar (capacidades del navegador)

Se registran como `clientTools` del agente de ElevenLabs. APOLLO decide cuándo llamarlas.

**Navegación y UI**
- `navigate_to(route)` — moverse entre `/missions`, `/chat`, `/memories`, etc.
- `open_mission(id)` — abrir una misión concreta
- `create_mission(title, goal)` — lanzar una misión nueva sin tocar el teclado
- `show_toast(message, kind)` — feedback visual

**Memoria (reutiliza lo que ya existe)**
- `recall(query)` — busca en la memoria del usuario antes de responder
- `remember(content, tags)` — guarda algo que el usuario le acaba de contar
- `forget(id)` — borrar un recuerdo concreto

**Sistema (browser APIs)**
- `copy_to_clipboard(text)`
- `read_clipboard()` (con permiso del usuario)
- `notify(title, body)` — Web Notifications API
- `get_location()` — Geolocation API, solo si el usuario acepta
- `open_url(url, new_tab)`
- `download_file(filename, content)`
- `get_current_context()` — devuelve la ruta actual, título de página, hora local, idioma del navegador, para que APOLLO sepa "dónde está" el usuario

**Auto-mejora**
- `update_self_personality(prompt_delta)` — APOLLO puede ajustar su propio prompt cuando el usuario le dice "no me hables así" o "recuérdame esto siempre". Se guarda como memoria especial con tag `persona`.

---

## 4. Cómo "va aprendiendo del usuario"

Tres capas, todas usando el sistema de memoria que **ya existe** (`memory.functions.ts`):

1. **Recall pre-respuesta**: antes de cada turno de voz, el servidor recupera las top-K memorias relevantes a lo que el usuario acaba de decir y las inyecta en el prompt del agente vía `overrides.agent.prompt`.
2. **Auto-captura post-respuesta**: cada intercambio (transcript usuario + respuesta APOLLO) se guarda como memoria con tag `voice` — igual que ya hace `/api/chat`.
3. **Persona evolutiva**: las memorias con tag `persona` se concatenan al system prompt base. Así "siempre llámame por mi nombre" o "no me digas 'claro'" se vuelve permanente.

---

## 5. Arquitectura técnica

```text
┌─────────────────────────────────────────┐
│  Browser                                │
│                                         │
│  VoiceOrb (button)  ──┐                 │
│  TranscriptPanel  ────┤                 │
│                       │                 │
│  useConversation()    │                 │
│  (@elevenlabs/react)  │                 │
│         │             │                 │
└─────────┼─────────────┼─────────────────┘
          │ WebRTC      │ HTTP
          │             ▼
          │      ┌──────────────────────────────┐
          │      │ POST /api/voice/token        │
          │      │  → recall memories           │
          │      │  → build dynamic prompt      │
          │      │  → mint ElevenLabs token     │
          │      └──────────────────────────────┘
          │
          ▼
   ElevenLabs Agents
   (STT + LLM + TTS + interruption)
          │
          ▼ client tool calls
   Back to browser → execute → return result
          │
          ▼ end of turn
   POST /api/voice/transcript  → save to memories
```

**Por qué token server-side**: la `ELEVENLABS_API_KEY` jamás toca el cliente, y el endpoint puede inyectar memoria/persona en `overrides` en cada sesión.

---

## 6. Cambios concretos

**DB** — una migration:
- Nueva tabla `voice_sessions` (`user_id`, `started_at`, `ended_at`, `turn_count`, `transcript_jsonb`) con RLS por usuario, para historial de conversaciones.

**Backend** (TanStack server routes / functions):
- `src/routes/api/voice/token.ts` — server route POST: recall memorias + persona, llama a ElevenLabs `/v1/convai/conversation/token`, devuelve `{ token, overrides }`.
- `src/routes/api/voice/transcript.ts` — server route POST: recibe transcripts del turno y los guarda en `memories` + `voice_sessions`.
- `src/lib/voice.functions.ts` — server fns: `listVoiceSessions`, `getVoiceSession`, `updateVoicePersonality`.
- Crear/configurar el **agente en ElevenLabs**: hay que crearlo una vez en el dashboard de ElevenLabs y guardar su `agent_id` como secret `ELEVENLABS_AGENT_ID`. El plan registra las client tools y los overrides permitidos.

**Frontend**:
- `src/components/voice/voice-orb.tsx` — botón flotante animado con estados.
- `src/components/voice/transcript-panel.tsx` — panel lateral con transcripción.
- `src/components/voice/voice-provider.tsx` — wrapper de `useConversation` con todas las `clientTools` registradas.
- `src/lib/voice/tools.ts` — implementación de cada tool (navegación, clipboard, geo, etc.).
- Montar `<VoiceProvider>` en `src/routes/_authenticated.tsx` para que esté disponible en toda la app autenticada.
- `src/routes/_authenticated/voice.tsx` — página de configuración + historial.
- Añadir item "Voice" al sidebar con icono `Mic`.

**Dependencias**: `bun add @elevenlabs/react`.

**Secrets**: `ELEVENLABS_API_KEY` y `ELEVENLABS_AGENT_ID` (los pediré con `add_secret` cuando empecemos).

---

## 7. Por qué este enfoque

- **ElevenLabs Agents** te da interrupción nativa (puedes cortarle a media frase) y latencia <500ms — sin eso no se siente Jarvis.
- **Push-to-talk** evita falsos positivos y respeta privacidad — escucha solo cuando tú quieres.
- **Tools del navegador, no del SO** = sigue funcionando idéntico cuando empaquetemos en Electron más adelante, y ahí solo añadimos tools nativas extra.
- **Memoria + persona evolutiva** = "consciente y que aprende" sin entrenar nada, todo vía retrieval e inyección de contexto.

---

## 8. Lo que NO entra en este plan

- Wake word ("Hey Apollo") — requiere Picovoice y solo brilla en desktop.
- Acceso al sistema operativo (apps nativas, ficheros, AppleScript) — eso vuelve cuando hagamos la desktop app híbrida.
- Conectores cloud (Calendar, Gmail) — fácil de añadir después como nuevas tools sin tocar la arquitectura.

---

¿Lo ejecuto tal cual, o quieres ajustar algo (voz por defecto, lista de tools, modelo del agente) antes?
