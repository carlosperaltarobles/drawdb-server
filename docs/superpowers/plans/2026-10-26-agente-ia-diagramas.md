# Agente de IA para diagramas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para coordinar este plan tarea por tarea. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Método solicitado y aprobado:** las tareas de desarrollo las ejecutan sesiones de **Cline CLI en paralelo**, con worktrees separados, usando su conexión LiteLLM existente. El coordinador revisa, prueba e integra los resultados. Cline no atiende las conversaciones del producto.

**Goal:** Añadir chat persistente por usuario/proyecto, selección dinámica de modelo, análisis de esquemas grandes y propuestas con vista previa y confirmación atómica, terminando con una auditoría de seguridad.

**Architecture:** El frontend conversa con una API autenticada del backend; un adaptador consume LiteLLM y convierte respuestas/herramientas en propuestas validadas. El documento vigente y las confirmaciones pasan por `RoomManager`, coordinadas con operaciones manuales, restauraciones y guardados. El chat consulta detalles del esquema por páginas y comparte únicamente los cambios confirmados.

**Tech Stack:** React 18, Semi UI, i18next, Vitest y playwright-core en frontend; TypeScript, Express, Zod, Prisma/PostgreSQL, Socket.IO y fetch del runtime Node en backend. Reutilizar dependencias instaladas; no introducir un framework de agentes.

**Spec:** [Diseño aprobado](../specs/2026-10-26-agente-ia-diagramas-design.md). Leerlo completo antes de ejecutar cada tarea; este plan fija interfaces y orden, no reduce su alcance.

## Global Constraints

- Frontend `FE = /home/carlos/Proyectos/drawdb`; backend `BE = /home/carlos/Proyectos/drawdb-server`. Los nombres de archivos siguientes son relativos al repositorio indicado.
- Solo proyectos autenticados. Conversaciones privadas por usuario/proyecto; viewers conversan y analizan, editores/admins pueden preparar y aceptar modificaciones.
- El backend conserva la credencial de LiteLLM. El navegador elige alias del catálogo permitido, nunca destinos, claves o instrucciones de sistema.
- Catálogo cacheado por conexión/credencial/política durante 60 segundos; refresco explícito limitado y sin fallback silencioso de modelo.
- Una generación activa por usuario, máximo global cuatro; diez solicitudes/minuto/usuario y treinta/minuto/proyecto.
- Mensaje máximo de 8.000 caracteres; historial reciente hasta 20 mensajes; contexto de esquema hasta 200 KiB/call, además del presupuesto total del modelo; páginas iniciales de 25 entidades.
- Generación hasta 60 segundos y doce rondas; una corrección estructurada adicional dentro del mismo presupuesto; máximo 500 operaciones/propuesta.
- Más de 200 entidades es uso habitual. Probar 200, 500 y 1.000 tablas y sus campos/relaciones; esos tamaños no son límites del proyecto.
- Una propuesta pendiente por conversación, TTL 24 horas; conversaciones inactivas 30 días; copias `pre_ai_apply` 30 días.
- No cambiar `database`/`sqlHeader` mediante IA ni ejecutar SQL, shell o código del modelo. No publicar propuestas parciales, obsoletas ni automáticas.
- Cambios gráficos y vistas derivadas parten del mismo documento. No alterar el comportamiento de diagramas exclusivamente locales.
- Sin despliegue ni cambios sobre proyectos/servicios reales. Tests con datos y proveedor simulados; prueba externa mínima de capacidades separada de la auditoría.
- No declarar terminado el trabajo sin integración verificada, mediciones de escala y auditoría `security-audit` del código final, con bloqueos documentados si existen.

## Review Focus

1. Una confirmación de IA compite con una edición manual, restauración o guardado anterior: nunca pierde trabajo ni difunde una versión distinta de la persistida (Task 6).
2. Un alias cambia de capacidades, desaparece o se revoca mientras una conversación está abierta: mantener contexto/selección, pedir nueva elección y no elevar permisos por caché (Tasks 2, 5, 7).
3. Una dependencia queda fuera de la página de esquema visible para el modelo: renombrar/eliminar valida el grafo completo sin referencias colgantes (Tasks 3, 10).
4. Una generación sigue viva al cambiar de pestaña, usuario o proyecto, o llega dos veces un evento terminal: no filtra texto ni reemplaza una revisión nueva (Tasks 5, 7, 8).
5. Una respuesta válida para un proveedor contiene contenido interno de herramientas incompatible con el siguiente: reconstruir historial canónico y no ejecutar ni mostrar instrucciones internas (Tasks 2, 5, 7).

## Contratos compartidos que deben fijarse antes del paralelo

El coordinador publica `docs/superpowers/contracts/2026-10-26-agente-ia.md` y un fixture JSON portable en ambos repositorios al ejecutar Task 1. Esos contratos contienen las siguientes decisiones; cambios posteriores se coordinan antes de continuar ambas ramas.

### Tipos públicos

- `Id = string | number` para entidades del diagrama; UUID string para conversaciones, mensajes, generaciones y propuestas. No convertir IDs de entidades a strings sin mantener su identidad original.
- `ModelChoice = { id, label, provider: string|null, capabilities: { chat, tools, json, stream: boolean|null }, contextWindow: number|null, maxOutputTokens: number|null }`.
- `ModelCatalog = { items: ModelChoice[], fetchedAt: string|null, stale: boolean, defaultModel: string|null }`. Una capacidad `null` significa desconocida, no autorizada.
- `Conversation = { id, projectId, selectedModel: string|null, title: string|null, updatedAt: string, activeGenerationId: string|null }`.
- `Message = { id, role: 'user'|'assistant', content, status: 'pending'|'complete'|'failed'|'cancelled', requestedModel: string|null, reportedModel: string|null, usage: object|null, createdAt: string }`.
- `Proposal = { id, revision, conversationId, requestedModel, reportedModel, baseVersion: number, baseHash: string, status: 'pending'|'superseded'|'discarded'|'applied'|'expired', summary: ChangeSummary, warnings: string[], expiresAt, appliedVersion: number|null, snapshotId: string|null }`.
- `ChangeSummary = { counts: { added, modified, removed }, items: { coll, id, parentId?: Id, change: 'added'|'modified'|'removed', beforeName?: string, afterName?: string, properties: string[] }[] }`. El cliente pagina los items; las marcas del lienzo se derivan de los mismos identificadores.
- Detalle de propuesta: `{ proposal: Proposal, before: Document, after: Document, stale: boolean }`. Se descarga al pedir vista previa, no con la lista de mensajes.
- `Document` y `Op` son los actuales de `src/collab/ops.*`. La respuesta interna del modelo es `{ text: string, warnings: string[], ops: Op[] }`; el servidor reemplaza/normaliza IDs nuevos, valida y calcula resumen/base. No se admiten operaciones `set`.
- Contratos internos: `ProviderInput = { model: ModelChoice, messages: CanonicalMessage[], tools: ToolDefinition[], mode: 'tools'|'json'|'text', maxOutputTokens: number }`; mensajes canónicos con rol/contenido/resultados validados, nunca objetos de SDK de proveedor. `ProviderEvent` discrimina texto, solicitud de herramienta completa, uso y finalización; su parser no publica argumentos parciales como herramientas ejecutables.
- Recuperación: `Scope = { entities: { coll: Coll, id: Id }[] | null }` (`null` significa proyecto completo); editar subelementos exige incluir su entidad propietaria. `ContextPage = { items: object[], nextCursor: string|null, scope: Scope, baseVersion: number, baseHash: string, coverage: { reviewed: number, remaining: number }, bytes: number }`. Los detalles exactos de cada herramienta se congelan con el fixture antes de iniciar ambas sesiones.

### HTTP y eventos

Todas las rutas empiezan con `/api/projects/:id/ai`, requieren sesión y permiso actual. Las conversaciones/generaciones/propuestas comprueban también propietario y proyecto; un ID ajeno se responde como 404.

| Ruta                                              | Entrada y respuesta                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------- | ------- |
| `GET /models?refresh=1`                           | `ModelCatalog`; `refresh=1` limitado por usuario y conexión                                                                                          |
| `GET /conversations?cursor=&limit=`               | `{ items: Conversation[], nextCursor: string                                                                                                         | null }`, máximo 50  |
| `POST /conversations`                             | `{ selectedModel?: string }` → 201 `Conversation`                                                                                                    |
| `PATCH /conversations/:cid`                       | `{ selectedModel: string }` → `Conversation`; 409 si existe generación activa                                                                        |
| `DELETE /conversations/:cid`                      | Cancelar trabajo propio y borrar conversación → 204                                                                                                  |
| `GET /conversations/:cid/messages?cursor=&limit=` | `{ items: Message[], proposals: Proposal[], nextCursor: string                                                                                       | null }`, máximo 50  |
| `POST /conversations/:cid/messages`               | `{ content: string, requestId: UUID, continuation?: string }` → 202 `{ generationId: string }`; repetir requestId propio devuelve el mismo resultado |
| `GET /generations/:gid`                           | `{ id, status, messageId, proposalId: string                                                                                                         | null, error: string | null, continuation: string | null }` |
| `GET /generations/:gid/events`                    | SSE autenticado por cookie, con `Last-Event-ID` para reanudar                                                                                        |
| `POST /generations/:gid/cancel`                   | Cancelar de forma idempotente → 204                                                                                                                  |
| `GET /proposals/:pid`                             | Detalle privado de vista previa                                                                                                                      |
| `POST /proposals/:pid/apply`                      | `{ revision: number }` → `{ proposalId, revision, version, snapshotId, applied: true }` idempotente                                                  |
| `POST /proposals/:pid/discard`                    | Invalidar revisión pendiente → 204                                                                                                                   |

Eventos SSE: `generation` (`generationId`, `messageId`, `requestedModel`), `text` (`delta`), `progress` (`reviewed`, `remaining`, `scope`, `baseVersion`), `proposal` (`proposalId`, `revision`), `done` (`messageId`, `proposalId`, `continuation`) y `error` (`code`). Todos tienen ID monotónico por generación; nunca transportan operaciones parciales ni secretos. Buffer acotado de replay; si ya no cubre el cursor, el cliente recupera mensajes/estado canónico. Heartbeat sin contenido privado; aplicar presión de salida y cerrar clientes demasiado lentos.

Errores del dominio: `ai_disabled` 503, `ai_unavailable` 503, `ai_limit` 429, `ai_busy` 409, `ai_model_unavailable` 409, `ai_unsupported` 422, `ai_invalid_proposal` 422, `ai_stale_proposal` 409, `ai_expired_proposal` 409; conservar `invalid_input`, `forbidden`, `not_found` existentes. No devolver cuerpos crudos del proveedor.

## Archivos y responsabilidades

| Repositorio | Archivos nuevos principales                                                                                                            | Responsabilidad                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| BE          | `src/ai/types.ts`, `config.ts`, `provider.ts`, `sse.ts`, `models.ts`                                                                   | Tipos, límites, transporte LiteLLM, parser y catálogo            |
| BE          | `src/ai/document-index.ts`, `context.ts`, `entity-schemas.ts`, `proposal-validation.ts`, `change-summary.ts`                           | Recuperación paginada, presupuesto y validación semántica        |
| BE          | `src/ai/repository.ts`, `conversations.ts`, `generation.ts`, `generation-registry.ts`, `routes.ts`, `schemas.ts`, `retention.ts`       | Privacidad, persistencia, orquestación, HTTP y limpieza          |
| BE          | `src/collab/project-queue.ts`, `src/ai/apply-proposal.ts`                                                                              | Serialización de escrituras y confirmación transaccional         |
| FE          | `src/api/ai.js`, `src/ai/stream.js`, `chat-state.js`, `ChatController.js`, `AiProvider.jsx`                                            | API, estado del chat y ciclo de vida                             |
| FE          | `src/ai/AiPanel.jsx`, `ModelSelector.jsx`, `MessageList.jsx`, `ProposalCard.jsx`, `ProposalPreviewBanner.jsx`, `PreviewHighlights.jsx` | Interfaz del asistente y vista previa                            |
| FE          | `scripts/perf/ai-large-diagrams.mjs`, `scripts/e2e/ai-project.mjs`                                                                     | Verificación visual, contratos e interacción grande con fixtures |

Mantener pequeños los módulos y separar helpers cuando crezcan; no concentrar la implementación en `RoomManager` o `AiPanel`. Cada tarea enumera también archivos existentes que modifica.

## Task 1: Preparación aislada, contratos y línea base

**Responsable:** coordinador. **Files:** crear `FE/docs/superpowers/contracts/2026-10-26-agente-ia.md`, fixtures idénticos `FE/src/ai/__fixtures__/protocol.json` y `BE/tests/ai/fixtures/protocol.json`; crear `FE/scripts/perf/ai-fixtures.mjs`, `FE/scripts/perf/ai-baseline.mjs` y `BE/vitest.unit.config.ts`. Modificar configuración de test solo para separar tests unitarios sin DB del setup de integración en BE.

**Interfaces:** `makeLargeDiagram({ tables: 200|500|1000, fieldsPerTable: 20, density: 'sparse'|'dense', seed: number }) -> Document`; sparse `E=V`, dense `E=5V`, IDs deterministas y documentación de versiones del fixture. Baseline JSON con entorno, fixture, frame p95, máxima tarea larga y memoria disponible.

- [ ] **Step 1:** Leer `using-git-worktrees` al ejecutar; comprobar instrucciones locales/estado de ambos repositorios. Crear worktrees independientes `feat/ai-backend` y `feat/ai-frontend`, con estado local de Cline separado. Guardar los SHA base y no alterar trabajo previo. Resolver acceso de escritura al backend y directorio de auditoría cuando las operaciones lo requieran.
- [ ] **Step 2:** Publicar los contratos anteriores, fixtures y error/status/eventos, comprobar que ambos lectores consumen el mismo fixture sin dependencias cruzadas en runtime.
- [ ] **Step 3:** Preparar una DB de integración desechable exclusiva para la sesión backend. `tests/helpers/db.ts` trunca todas las tablas: exigir `DATABASE_URL_TEST` explícita y comprobar que es la DB desechable antes de ejecutar. No reutilizar DBs del usuario ni ejecutar dos suites contra la misma DB.
- [ ] **Step 4:** Usar el navegador instalado con fixtures sintéticos locales y proveedor falso; medir antes del cambio cinco corridas tras calentamiento con 200/500/1000 tablas. No usar el script anterior contra el proyecto real ni leer `.env` para autenticarse.
- [ ] **Step 5:** Fijar aceptación antes de escribir producto: frame p95 con asistente o preview ≤ `baseline * 1.10 + 2 ms`; ninguna tarea larga nueva >100 ms causada por streaming/diff; mediana de indexación+validación+resumen en caliente ≤500 ms para 1.000 tablas/20 campos/5.000 relaciones; memoria liberada al cerrar proyecto y sin crecimiento monotónico en diez aperturas. Registrar cualquier límite de medición del navegador.
- [ ] **Step 6:** Verificar fixture determinista y línea base, y guardar commit de contratos/fixtures en las ramas de ejecución. Sin publicar secretos ni procesos permanentes. Lanzar las dos sesiones Cline solo cuando compartan la misma versión del contrato.

## Task 2: Backend — catálogo dinámico y adaptador LiteLLM

**Files:** crear `BE/src/ai/{types,config,provider,sse,models}.ts`; modificar `BE/src/config/index.ts`; tests `BE/tests/ai/{models,provider,sse}.test.ts`.

**Interfaces:** `createAiProvider(config: AiConfig, fetcher = fetch): AiProvider`; `AiProvider.listModels(signal): Promise<ModelCatalog>`; `AiProvider.generate(input: ProviderInput, signal): AsyncIterable<ProviderEvent>`; `ModelCatalogService.get({ refresh, policyScope }): Promise<ModelCatalog>`; `resolveModel(id: string): Promise<ModelChoice>`.

- [ ] **Step 1:** Escribir tests `catalog_preserves_alias_and_strips_secrets`, `base_url_has_one_v1`, `unknown_capability_is_not_supported`, `ttl_and_singleflight_follow_policy`, `refresh_failure_does_not_change_model`, `sse_handles_split_utf8_and_bounded_tool_arguments`. Afirmar TTL=60.000 ms, sin claves/URLs internas en JSON y llamadas separadas por credencial/política.
- [ ] **Step 2:** Ejecutar `./node_modules/.bin/vitest run --config vitest.unit.config.ts tests/ai/models.test.ts tests/ai/provider.test.ts tests/ai/sse.test.ts` → FAIL por módulos inexistentes. El config unitario de Task 1 excluye globalSetup de DB.
- [ ] **Step 3:** Implementar transporte con URL configurada, timeout/abort, tamaños máximos, saneamiento de errores y parser incremental SSE. Acotar catálogo a 2 MiB, respuestas de generación a 1 MiB y salidas de herramientas al presupuesto del contexto. Modelos sin chat verificado quedan no seleccionables; capacidades por alias proceden de metadata permitida o configuración, nunca de heurísticas de nombre.
- [ ] **Step 4:** Implementar herramientas nativas y JSON estructurado; alternativa de respuesta completa si no hay streaming. Probar cambio entre modelos con diferentes ventanas/herramientas y no reenviar mensajes internos incompatibles. No ejecutar pruebas pagadas automáticas para llenar el catálogo.
- [ ] **Step 5:** Repetir el comando unitario → PASS; `npm run build` → PASS con cliente Prisma generado localmente. Revisar diff y guardar commit `feat: add LiteLLM model discovery and provider adapter`.

## Task 3: Backend — recuperación del esquema y propuestas válidas

**Files:** crear `BE/src/ai/{document-index,context,entity-schemas,proposal-validation,change-summary}.ts`; tests `BE/tests/ai/{context,proposal-validation,change-summary}.test.ts`. Usar `BE/src/collab/ops.ts`, `validate.ts` existentes y tomar las propiedades reales de `FE/src/data/schemas.js`, `databases.js`, `datatypes.js` como referencia de contrato.

**Interfaces:** `indexDocument(doc: Document): DocumentIndex`; `queryContext(index, { query?, ids?, cursor?, part?, limit?, direction? }, budget): ContextPage`; `prepareProposal(base: Document, raw: unknown, scope: Scope): { after: Document, ops: Op[], summary: ChangeSummary, warnings: string[] }`; `hashDocument(doc): string` canónico SHA-256, preservando identidad string/number.

- [ ] **Step 1:** Tests de paginación real con 1.000 tablas y entidad individual enorme; catálogo que supera 200 KiB; cursores vinculados a versión/consulta; dependencias fuera del contexto; IDs mixtos; cambio de motor/header prohibido; propiedades desconocidas/prototipos; duplicados; renombrado de campo actualiza índice por nombre y referencias por ID; eliminación que rompe vista se rechaza; SQL libre ambiguo bloquea la propuesta.
- [ ] **Step 2:** `./node_modules/.bin/vitest run --config vitest.unit.config.ts tests/ai/context.test.ts tests/ai/proposal-validation.test.ts tests/ai/change-summary.test.ts` → FAIL.
- [ ] **Step 3:** Implementar mapas por entidad y referencias entrantes/salientes. Contexto con catálogo/búsqueda/detalle/campos paginados, cobertura y continuación, presupuesto de todo el prompt incluida salida. Los cursores no pueden cambiar el proyecto, base o alcance. Sin recursión no acotada ni caché por token.
- [ ] **Step 4:** Validar schemas cerrados por entidad y resultado semántico completo. Normalizar IDs nuevos y referencias juntas; preservar layout salvo reorganización explícita. Aceptar solo las operaciones válidas como conjunto, sin reutilizar como confirmación la aplicación parcial de `applyOps`. Validar herencia, tipos/enums, joins/columns/conditions, índices por nombre y constraints con los formatos reales del editor.
- [ ] **Step 5:** Calcular resumen verificable y diferenciar problemas preexistentes de los nuevos sin publicar un documento incoherente. Añadir tests sobre cada colección soportada y al menos un motor con tipos/enums y uno que no los soporte.
- [ ] **Step 6:** Repetir tests → PASS y ejecutar medición pura de Task 1. Guardar commit `feat: validate and retrieve diagram changes at scale`.

## Task 4: Backend — conversaciones privadas y retención

**Files:** modificar `BE/prisma/schema.prisma`; crear migración `BE/prisma/migrations/<timestamp>_ai_agent/migration.sql`, `BE/src/ai/{repository,conversations,retention}.ts`; tests `BE/tests/ai/{conversations,retention}.test.ts`; modificar helpers de test cuando acepten nuevas dependencias.

**Interfaces:** `ConversationService.list/create/getMessages/setModel/remove(projectId, user, input)`; `AiRepository` persiste conversaciones, mensajes, generaciones y propuestas; `pruneAiData(tx, now): Promise<PruneResult>`; `startAiRetention(db): () => void`.

- [ ] **Step 1:** Tests con editor/viewer/outsider y otro usuario del mismo proyecto: solo propietario lee mensajes/modelo/propuestas; viewer conversa pero no propone; cambio de modelo activo devuelve409; borrado cancela; orden/paginación de mensajes no mezcla proyectos; 30 días de inactividad y TTL24h; borrar conversación no borra snapshots.
- [ ] **Step 2:** Ejecutar `./node_modules/.bin/vitest run tests/ai/conversations.test.ts tests/ai/retention.test.ts --no-file-parallelism` sobre DB desechable → FAIL.
- [ ] **Step 3:** Añadir `AiConversation`, `AiMessage`, `AiGeneration`, `AiProposal`. Generación durable con requestId único por conversación/usuario, estado, modelo fijado, mensaje y continuación; no depender del registro en memoria para saber el estado terminal. Guardar base JSON una vez por propuesta, no por delta de texto. Índices de propietario/proyecto/fecha, conversación/fecha y status/expiry; relaciones snapshot opcionales con `onDelete: SetNull`.
- [ ] **Step 4:** Añadir `SnapshotKind.pre_ai_apply` en migración compatible. Repositorio filtra propietario/proyecto en cada lectura/mutación. Cron de retención por lotes con lock transaccional, sin borrar trabajo activo ni contadores de idempotencia vigentes. Al reiniciar, generaciones pendientes sin proceso activo pasan a fallidas de manera recuperable.
- [ ] **Step 5:** Aplicar migración únicamente a la DB de pruebas, generar cliente, repetir tests → PASS y `npm run build` → PASS. Revisar SQL y guardar commit `feat: persist private AI conversations and proposals`.

## Task 5: Backend — orquestación, streaming y API autenticada

**Files:** crear `BE/src/ai/{generation,generation-registry,project-source,routes,schemas}.ts`; modificar `BE/src/{app,server,index}.ts`, `BE/src/http/app-error.ts`, helpers de tests; tests `BE/tests/ai/{generation,routes,limits}.test.ts`.

**Interfaces:** `AiGenerationService.start(projectId, conversationId, user, { content, requestId, continuation? }): Promise<{ generationId }>`; `cancel/get/events(projectId, generationId, user)`; `GenerationRegistry` gestiona AbortController, límites y replay acotado; `aiRouter(deps: AiDeps): Router`. `AiRooms.read(projectId): Promise<{ doc, version, epoch, baseHash }>` se implementa en `project-source.ts` sobre el `RoomManager.join()` existente y hash de Task3. Inyectar proveedor/clock para pruebas; configurar `AppDeps.ai?`, deshabilitado por defecto si falta configuración. La ruta apply consume un callback inyectable con la firma de `commitProposal` de Task6: usar doble en pruebas y responder indisponible hasta conectarlo, sin importar un módulo que aún no existe.

- [ ] **Step 1:** Tests de toda ruta del contrato con401/403/404 correctos, propiedad ajena dentro del mismo proyecto, protección same-origin para mutaciones, csrf desde origin ajeno, consulta catálogo saneada y modelos arbitrarios rechazados. Verificar que viewer no obtiene herramienta de propuesta.
- [ ] **Step 2:** Tests fake provider: texto+herramientas, JSON incompleto, un intento de reparación, cancelación antes/durante respuesta, timeout60s, límite12 rondas,20 mensajes/8.000 caracteres/200KiB, una generación/usuario, cuatro globales,10/min usuario y30/min proyecto; decremento de límites incluso tras error. Prueba petición repetida idempotente y reanudación SSE sin mensajes duplicados.
- [ ] **Step 3:** Ejecutar `./node_modules/.bin/vitest run tests/ai/generation.test.ts tests/ai/routes.test.ts tests/ai/limits.test.ts --no-file-parallelism` → FAIL.
- [ ] **Step 4:** Implementar orquestación con captura de base vigente, historial canónico y herramientas de solo lectura/propuesta de Task 3. Revalidar acceso al publicar resultados y en cada nueva lectura; revocar/cancelar cierra suscriptores. Preparar propuesta solo cuando la respuesta completa pasa validación; sustituir revisión pendiente transaccionalmente. Los límites globales se reservan antes de llamar al proveedor y se liberan en `finally`.
- [ ] **Step 5:** Para análisis grande, persistir continuación, cobertura y baseHash; reinicio/cambio de versión la invalida. Para >500 ops, devolver etapas propuestas con dependencias; cada etapa posterior se genera tras aceptar la anterior, sin ejecutar etapas automáticamente. Progreso y respuesta explican cobertura parcial.
- [ ] **Step 6:** Implementar rutas y eventos definidos, cursor/replay acotados, heartbeat y backpressure; respuesta final persistida antes de `done`. Evitar fanout del texto privado por Socket.IO. Cancelar/delete/shutdown abortan jobs y no aceptan respuestas tardías. Registrar solo métricas no secretas.
- [ ] **Step 7:** Repetir suites → PASS, `npm run lint` y `npm run build` → PASS. Guardar commit `feat: expose authenticated AI chat and generation lifecycle`.

## Task 6: Backend — confirmación atómica y colaboración

**Files:** crear `BE/src/collab/project-queue.ts`, `BE/src/ai/apply-proposal.ts`; modificar `BE/src/collab/{rooms,socket}.ts`, `BE/src/history/{prune,types}.ts`, `BE/src/ai/routes.ts`; tests `BE/tests/ai/apply-proposal.test.ts`, `BE/tests/collab/{rooms,socket}.test.ts`, `BE/tests/history/prune.test.ts`.

**Interfaces:** `ProjectQueue.run<T>(projectId, work: () => Promise<T>): Promise<T>`; `RoomManager.apply(...)` pasa a Promise conservando su resultado; `RoomManager.commitProposal({ projectId, proposalId, revision, user }): Promise<{ proposalId, revision, version, snapshotId, applied: true }>`; conservar `AiRooms.read` de Task5 y conectarle la lectura coherente con la cola.

- [ ] **Step 1:** Tests de barreras controladas: aplicar IA vs apply manual; IA vs restore; guardado anterior suspendido vs commit IA; dos confirmaciones idénticas; confirmación de revisión sustituida/TTL vencido; pérdida de membresía durante espera; error de snapshot/update/commit; caída después de persistir antes de responder. Afirmar una sola copia previa, versión única, cero difusión antes de commit y jamás publicación parcial.
- [ ] **Step 2:** Ejecutar `./node_modules/.bin/vitest run tests/ai/apply-proposal.test.ts tests/collab/rooms.test.ts tests/collab/socket.test.ts tests/history/prune.test.ts --no-file-parallelism` → FAIL en nuevas garantías.
- [ ] **Step 3:** Serializar por proyecto todas las mutaciones relevantes: manual, restore, commit IA, liberación/eliminación y guardado. Dividir métodos en wrapper en cola y operaciones internas sin reentrada. Un timer encola flush y nunca llama a una cola desde un trabajo que ya la posee. Adaptar socket a `await rooms.apply` y las pruebas/consumidores correspondientes; preservar50ms del cliente y debounce2s.
- [ ] **Step 4:** Revalidar autorización dentro de la transacción con lecturas/bloqueos del proyecto/membresía pertinentes, estado de propuesta, versión/huella y documento. Esperar escrituras anteriores; persistir snapshot previo, doc/version y propuesta aplicada juntos. Solo después reemplazar sala/doc/savedVersion y difundir `ops` a todos incluido solicitante. Guardar `appliedResult` JSON inmutable con el ID original del snapshot: repetición devuelve ese resultado aun si la FK opcional pasa a null al expirar el snapshot.
- [ ] **Step 5:** Mantener la aceptación de lotes sin epoch por compatibilidad existente. No emitir un ack de edición local por el commit HTTP. Los clientes con trabajo en vuelo rebasan/resincronizan por su camino normal; prueba con dos clientes y un lote sin ack al llegar la difusión de IA. Retención incluye `pre_ai_apply` durante30 días sin cooldown.
- [ ] **Step 6:** Repetir suites → PASS; ejecutar toda la suite backend en DB exclusiva, lint/build. Guardar commit `feat: commit AI proposals atomically with project collaboration`.

## Task 7: Frontend — cliente, selector y estado de conversación

**Files:** crear `FE/src/api/ai.js`, `FE/src/ai/{stream,chat-state,ChatController}.js`; tests `FE/src/ai/{stream,chat-state,ChatController}.test.js`, `FE/src/api/ai.test.js`.

**Interfaces:** `createAiApi({ fetcher = fetch }): AiApi` implementa rutas del contrato; `parseAiEvents(body, { signal, lastEventId }): AsyncIterable<AiEvent>`; `ChatController({ projectId, api, onState, beforeSend }): { open, selectConversation, createConversation, selectModel, send, cancel, remove, refreshModels, stop }`; `chatReducer(state, event): ChatState` puro.

- [ ] **Step 1:** Tests contra fixtures del contrato: SSE dividido/UTF8, evento duplicado, terminal repetido, replay insuficiente, respuesta completa sin streaming y error saneado. Cambiar modelo/conversación/proyecto con respuesta tardía conserva la selección y no cruza mensajes. Al borrar/cerrar, cancelar generación y listeners sin perder historial persistido.
- [ ] **Step 2:** `./node_modules/.bin/vitest run src/api/ai.test.js src/ai/stream.test.js src/ai/chat-state.test.js src/ai/ChatController.test.js` → FAIL.
- [ ] **Step 3:** Implementar controller por proyecto/usuario con generaciones de petición y AbortController; selección privada persistida, modelos obsoletos visibles con error y refresco. `beforeSend()` espera sincronización de Task 9; usar mock mientras se desarrolla en paralelo. Reducer no reconstruye todos los mensajes ni esquema por cada token.
- [ ] **Step 4:** Garantizar que mensajes sin selección válida no se envían; durante generación bloquear cambio de modelo; al recuperar proyecto cargar paginado y estado canónico, no repetir POST para reanudar. Probar dos controllers de usuarios distintos y dos conversaciones con elecciones diferentes.
- [ ] **Step 5:** Repetir tests → PASS y `npm run lint` → PASS. Guardar commit `feat: add persistent AI chat client and model selection state`.

## Task 8: Frontend — chat accesible e integración visual

**Files:** crear `FE/src/ai/{AiProvider,AiPanel,ModelSelector,MessageList,ProposalCard}.jsx`; modificar `FE/src/pages/ProjectEditor.jsx`, `FE/src/components/Workspace.jsx`, `FE/src/i18n/locales/{en,es}.js`; tests `FE/src/ai/{AiPanel,ModelSelector,ProposalCard}.test.js`; crear `FE/scripts/e2e/ai-project.mjs`.

**Interfaces:** `AiProvider({ projectId, children })`; `useAiChat()` expone estado/controller; `AiPanel` y botón del asistente se conectan mediante slots `header-actions-end`/nuevo `workspace-aside`, sin envolver editor local; `ProposalCard({ proposal, onPreview, onApply, onDiscard, canApply })`.

- [ ] **Step 1:** Tests render estático para roles, estados catálogo vacío/error/stale/unknown, selector con búsqueda, etiqueta por respuesta/modelo, propuesta pendiente y texto malicioso escapado. Test navegador con proveedor/API falsos para enviar, cancelar, recargar conversación, cambiar modelo y teclado/foco.
- [ ] **Step 2:** `./node_modules/.bin/vitest run src/ai/AiPanel.test.js src/ai/ModelSelector.test.js src/ai/ProposalCard.test.js` → FAIL.
- [ ] **Step 3:** Implementar panel que convive con canvas y panel de tablas, cierre con foco al disparador, controles accesibles y tema claro/oscuro/RTL. Mostrar estado de análisis por etapas, cobertura y límites; renderizar como texto seguro y paginar mensajes/diferencias largos. Traducir en/es sin tocar idiomas ajenos.
- [ ] **Step 4:** Mostrar selector solo a usuarios con acceso al proyecto, distinguir conversación de capacidad para modificar y conservar panel al entrar en preview. Si AI está deshabilitada no aparece el acceso ni se afecta editor/historial.
- [ ] **Step 5:** Repetir tests → PASS; `npm test`, `npm run lint`, `npm run build` → PASS. Guardar commit `feat: add project AI chat and dynamic model picker`.

## Task 9: Frontend — vista previa aislada y sincronización

**Files:** modificar `FE/src/collab/{ProjectSession.js,ProjectCollabProvider.jsx,PreviewBanner.jsx,RemoteCursors.jsx,HistoryPanel.jsx}`, `FE/src/pages/ProjectEditor.jsx`; crear `FE/src/ai/{ProposalPreviewBanner,PreviewHighlights}.jsx`, `preview-state.js`, `preview-worker.js`; ampliar `FE/src/collab/{ProjectSession,HistoryPanel}.test.js` y crear `FE/src/ai/preview-state.test.js`.

**Interfaces:** `ProjectSession.flushPending({ timeoutMs = 10000 }): Promise<{ version, epoch }>`; `previewProposal(detail, { mode: 'before'|'after' })`, `endPreview()`, `getCurrentVersion()`; metadatos preview discriminados por `kind: 'history'|'ai'`. `useProjectCollab()` expone `flushPending`, `previewProposal`, `proposalStale` y versión vigente sin exponer internals mutables.

- [ ] **Step 1:** Tests sesión: flush envía timer pendiente y espera todos los ack, falla en desconexión/timeout; preview no emite ops/awareness, conserva pila undo y acumula remoto en documento vigente; historial/IA excluyentes; salir vuelve al estado más nuevo. Test ack/resync mientras se solicita enviar mensaje.
- [ ] **Step 2:** Tests con revisión2/3, preview anterior que llega tarde, cambio de versión/remoto/restauración y usuario viewer; no habilitar aplicar una propuesta obsoleta o ajena. Modelo cambiado no altera propuesta existente. Respuesta apply perdida consulta estado y resincroniza, sin replay de ops locales.
- [ ] **Step 3:** `./node_modules/.bin/vitest run src/collab/ProjectSession.test.js src/ai/preview-state.test.js` → FAIL.
- [ ] **Step 4:** Implementar aislamiento y before/after; usar botón apply HTTP que no modifica optimisticamente los contextos ni introduce inversas globales en undo. Si el evento remoto llega antes del HTTP, cerrar preview al conocer resultado y resync sin duplicar edición. Mostrar snapshot previo en historial con etiqueta `pre_ai_apply` traducida.
- [ ] **Step 5:** Marcar altas/modificaciones con overlay de identificadores sin recalcular todas las geometrías en cada token; bajas visibles en resumen y estado anterior. Usar worker o procesamiento fragmentado para diffs costosos según línea base; un requestId evita resultados de workers antiguos. Workers no reciben credenciales.
- [ ] **Step 6:** Repetir pruebas → PASS y suite FE/lint/build → PASS. Guardar commit `feat: preview AI diagram proposals without publishing edits`.

## Task 10: Integración entre repositorios y escala

**Responsable:** coordinador con Cline para correcciones aisladas. **Files:** completar `FE/scripts/e2e/ai-project.mjs`, crear `FE/scripts/perf/ai-large-diagrams.mjs`; ampliar `BE/tests/ai/large-projects.test.ts`; guardar evidencia sin secretos en `FE/docs/superpowers/verification/2026-10-26-ai-agent.md`.

**Interfaces:** el script de navegador recibe URL de backend de prueba y cuenta ficticia de fixture; jamás abre DBs/proyectos reales. Los tests de contrato comparan ambos fixtures y respuestas HTTP reales del backend de prueba.

- [ ] **Step 1:** Revisar y traer commits secuencialmente a las ramas de integración manteniendo historia de ambos repositorios. Ejecutar pruebas de protocolo/errores y resolver divergencias de contrato antes de probar el flujo completo.
- [ ] **Step 2:** Con dos usuarios ficticios y dos navegadores, demostrar chat privado, selección por conversación, propuestas compartidas solo al confirmar, edición remota durante preview y recuperación desde snapshot. Verificar también DBML y exportSQL desde el mismo documento resultante.
- [ ] **Step 3:** Ejecutar suites backend y FE completas, lint y build contra DB exclusiva; pruebas significativas del motor específico, tipos/enums y relaciones con IDs numéricos/string. No usar mocks como única prueba de atomicidad/persistencia.
- [ ] **Step 4:** Medir cinco corridas calentadas por fixture200/500/1000, incluyendo >200KiB, entidade/página enormes, grafos densos, errores de capacidad y limitación de contexto. Comprobar umbrales fijados en Task1 y publicar números/cobertura real. Ningún aumento de límites ni selección manual obligatoria sustituye un fallo de escala.
- [ ] **Step 5:** Medir diez aperturas/cierres, cancelaciones y cambios de proyecto; no quedan workers, suscriptores, buffers o cachés sin límite. Para >500ops, probar continuidad de las etapas y coherencia si el usuario se detiene entre propuestas.
- [ ] **Step 6:** Si una comprobación falla, Cline corrige la tarea propietaria, revisión y repetición solo de las pruebas afectadas y luego integración completa. Guardar commits revisados y evidencia; no declarar cumplida una medición no ejecutada.

## Task 11: Conexión real controlada y documentación de operación

**Responsable:** coordinador. **Files:** crear `BE/scripts/ai-capabilities.ts`, `BE/docs/ai-agent.md`; ampliar `FE/docs/deploy/dokploy.md` y evidencia de verificación.

**Interfaces:** prueba manual sin ejecución automática en tests: listar modelos y probar solo los alias elegidos con texto/herramienta de propuesta ficticia/JSON; límites de una salida breve por caso. Lee configuración segura del backend, no acepta claves como argumentos ni las imprime.

- [ ] **Step 1:** Configurar endpoint/credencial en secretos del entorno de ejecución permitido, reutilizando la conexión autorizada. `AI_ENABLED` no se habilita automáticamente para usuarios reales. Verificar listado y al menos dos alias si existen, sin agregar modelos ficticios.
- [ ] **Step 2:** Verificar capacidades para los alias a habilitar: tools/JSON/texto y ventana conocida. Una capacidad desconocida queda no habilitada para propuestas; registrar alias/fecha/resultado saneados. Esta prueba usa solo el proveedor autorizado, mensajes sintéticos y no ejecuta herramientas externas.
- [ ] **Step 3:** Documentar variables, capacidades por alias, selección/errores, presupuestos, despliegue de una sola instancia de colaboración, migración/rollback, retención, desactivación y diferencia entre probar conexión y probar propuestas. Explicar que eliminar chat conserva historial compartido.
- [ ] **Step 4:** Verificar que búsqueda de secretos en archivos nuevos no revela credenciales y que la UI/API solo usan configuración pública. Guardar commit de documentación; no publicar ni ejecutar migraciones sobre el servicio real.

## Task 12: Auditoría final obligatoria con security-audit

**Responsable:** coordinador usando la habilidad `security-audit` en modo completo, perfil `standard`, con verificadores independientes. **Target:** cambios implementados y dependencias de fronteras de confianza en FE y BE; base/final SHA registradas por repositorio. **Output propuesto:** `/home/carlos/security-audit-skill/drawdb-ai/run-<N>/frontend` y `/backend`, fuera de ambos repositorios y sujeto a acceso autorizado al ejecutar. No usar `/tmp` como alternativa.

**Interfaces:** artefactos por target: `run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`; resumen coordinado de los cruces FE↔BE. Leer la habilidad y sus companions/validadores completos al comenzar, no reemplazarlos por este resumen.

- [ ] **Step 1:** Resolver targets/output/source refs, revisar auditorías previas compatibles y crear metadata/ledger antes de delegar. Cubrir autorización entre usuarios/proyectos, catálogo y selección/cachés, streaming/cancelación, prompt injection/herramientas, XSS, secretos/destinos, lotes semánticos, concurrencia/snapshots y recursos con200+ entidades. El resto de los repos se declara fuera de alcance.
- [ ] **Step 2:** Ejecutar reconocimiento y búsqueda por cobertura con fronteras y evidencia concretas, directorios por agente y propiedad exclusiva del coordinador para archivos compartidos. Reservar verificación y críticas de cobertura según el perfil; no lanzar búsquedas que impidan completarlas.
- [ ] **Step 3:** Validar candidatos con revisores independientes. Ejecución de código exclusivamente en sandbox OS con red externa bloqueada/loopback aislado si hace falta, entorno allowlist vacío, HOME/cachés de scratch, fuente/toolchain read-only, escritura solo scratch y límites CPU/memoria/procesos/tamaño/disco/tiempo. Sin DB/proveedor real, secretos, instalaciones o quota pagada. Si faltan controles, solo lectura estática y `needs_validation` exacto.
- [ ] **Step 4:** Generar registros estructurados, verificar independientemente cada hallazgo final y validar `findings.json`/`coverage-ledger.json` con los validadores de la habilidad. Informes derivan de esos registros; severidad solo para `confirmed`.
- [ ] **Step 5:** Auditoría no modifica producto. Dar a Cline las correcciones confirmadas como tareas separadas, revisar diff, ejecutar regresiones y hacer verificación independiente de código corregido. Nuevos cambios materiales reciben cobertura adicional antes del informe final.
- [ ] **Step 6:** Entregar reportes completos y ambos validadores aprobados, o registrar/reportar `run_status: incomplete` con causa exacta y cobertura pendiente. No declarar seguridad validada si hay verificaciones bloqueadas. Conservar artefactos mínimos mediante la promoción segura definida por la habilidad.

## Task 13: Entrega y estado final

- [ ] Relacionar cada requisito del spec con su tarea, commit y verificación; incluir trabajo realmente ejecutado en paralelo por Cline, resultados y correcciones revisadas.
- [ ] Confirmar `npm test`, `npm run lint`, `npm run build` FE y equivalentes BE (tests `--no-file-parallelism` en DB desechable), protocolo cruzado, métricas de escala y auditoría sobre la revisión final. No repetir suites sin cambios o incertidumbres nuevas.
- [ ] Mostrar instrucciones de operación, migraciones pendientes, secretos por configurar y cualquier limitación sustentada. No declarar entregada una parte todavía bloqueada ni atribuir al código una capacidad del proveedor no verificada.
- [ ] Entregar ramas/cambios revisables y enlaces a plan, evidencia y auditoría. No push, merge a principal, despliegue o cambios en servicios reales sin la autorización correspondiente.

## Ejecución en paralelo y puntos de integración

1. Coordinador completa Task1 y comparte contratos/fixtures.
2. **Sesión Cline backend:** Tasks2→3→4→5→6 en su worktree. **Sesión Cline frontend concurrente:** Tasks7→8→9 en otro, con API simulada y contratos cerrados. Cada sesión revisa los tests de su tarea antes de pasar a la siguiente y entrega commits/diffs, comandos y resultados.
3. Las sesiones no tocan contratos, archivos de la otra sesión, configuración compartida de Cline, DB compartida ni ramas de integración. Una necesidad de cambiar el contrato se comunica al coordinador y bloquea únicamente el trabajo dependiente.
4. Coordinador integra y ejecuta Tasks10→11→12→13. La auditoría puede delegar investigación independiente conforme a su habilidad; no corre contra código que se modifica simultáneamente.
5. En cada tarea se registra estado mediante estas casillas y un registro breve de Cline sin contenido privado. Si Cline necesita un permiso fuera del alcance concedido, se resuelve por el mecanismo del entorno y se continúa; no se cambia de herramienta en silencio.

## Autorrevisión del plan

- Cobertura del spec: conversación/modelos Tasks2/4/5/7/8; validación/escalabilidad Task3/10; preview/confirmación Tasks6/9; retención Tasks4/6; operación Task11; Cline paralelo Task1/ejecución; auditoría Task12.
- Los cinco riesgos de Review Focus están ligados a tests de sus tareas propietarias.
- Las rutas/tipos/eventos se fijan una vez y los tests cruzados usan un fixture compartido. Las extensiones de frontend y backend conservan las formas actuales de `Document`/`Op`.
- Las decisiones internas de colas/sesiones no se trasladan al flujo del usuario; las condiciones visibles son modelo, generación, cobertura, propuesta y permiso.
