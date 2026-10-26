# Agente de IA para diagramas — Diseño

Fecha: 2026-10-26 · Repositorios: `drawdb` y `/home/carlos/Proyectos/drawdb-server`.

Estado: propuesta de diseño para la primera versión. Este documento no significa que la funcionalidad ya esté implementada.

## 1. Intención y acuerdos

Integrar un agente con el que se pueda conversar sobre el esquema de un proyecto, analizarlo y proponer modificaciones para mejorar la productividad. El usuario debe poder revisar una vista previa de los cambios antes de aplicarlos. Los cambios aceptados modifican el documento central y, por tanto, el gráfico y las demás representaciones derivadas.

El usuario indicó que dispone de una conexión con LiteLLM configurada en Cline y autorizó comprobarla. La ejecución de Cline respondió `CONEXION_OK`; su configuración activa seleccionaba el proveedor `litellm` y el modelo o alias `gemini-4-argon`. Esto acredita una respuesta de texto, no el soporte de todas las capacidades del agente.

El usuario también pidió expresamente **usar Cline para ejecutar en paralelo las tareas de desarrollo de esta funcionalidad**, y aclaró que esta petición se refiere al desarrollo. El flujo obligatorio se describe en la sección 12.

El usuario indicó que los proyectos reales llegan a **más de 200 entidades y pueden seguir creciendo**. Esta es una condición normal de uso desde la primera versión. También solicitó **auditar la seguridad de lo implementado al finalizar, usando `security-audit`**, como se detalla en la sección 13.

El usuario solicitó **elegir el modelo desde el chat y consultar dinámicamente los modelos disponibles**, tomando como referencia la experiencia de Cline. La lista no será fija ni estará limitada al modelo usado en la prueba de conexión.

La conexión del producto será frontend → backend de drawDB → LiteLLM → modelo elegido por el usuario entre los disponibles. Cline es una herramienta del desarrollo; no es una dependencia para atender conversaciones de los usuarios.

## 2. Alcance inicial y decisiones propuestas

Son decisiones del constructor para esta primera versión, sujetas a revisión del diseño:

- Trabajar con proyectos compartidos autenticados. El editor de diagramas exclusivamente locales queda para una ampliación posterior.
- Conversaciones privadas por usuario y proyecto, persistidas en el backend. Los cambios aceptados sí se comparten con los colaboradores.
- Chat para explicar el esquema, señalar problemas de diseño y responder preguntas, con respuestas en el idioma del usuario.
- Selector de modelo en el chat con catálogo consultado a LiteLLM, búsqueda y actualización de la lista, conservando la elección por conversación.
- Propuestas para crear, editar o eliminar tablas, campos, relaciones, índices, restricciones únicas, vistas, áreas, notas, tipos y enums, según las capacidades del motor de base de datos elegido.
- Una propuesta pendiente por conversación. El usuario puede pedir ajustes que producen una nueva revisión de la propuesta, aceptar el conjunto o descartarlo.
- Vista previa en el lienzo del propio editor, con resumen de diferencias y marcas visuales. Ninguna modificación se publica antes de confirmar.
- Aplicación completa de una propuesta como una sola acción atribuida al usuario que la acepta, con registro en el historial y posibilidad de revertirla.
- El motor de base de datos del proyecto no se cambia desde el agente en esta versión. El encabezado SQL puede analizarse; su edición por IA queda fuera del alcance inicial.
- Soportar proyectos con más de 200 entidades sin exigir enviar el esquema completo al modelo ni obligar al usuario a elegir tablas manualmente para poder conversar. Los límites de cada llamada al proveedor no se convierten en un límite de tamaño del proyecto.

## 3. Fuera de alcance y condiciones de fracaso

No se ejecutan migraciones ni consultas contra bases de datos reales, comandos del sistema o código producido por el modelo. Tampoco se conecta Cline al servidor de producción para ejecutar instrucciones de los usuarios. No se incorporan búsqueda web, herramientas externas, múltiples agentes de producto ni aplicación parcial de una propuesta en esta versión.

Sería un fallo del diseño que una vista previa se propagara a otros usuarios, que el agente ignorara permisos, que una respuesta inválida cambiara parcialmente el esquema o que una propuesta antigua sobrescribiera ediciones posteriores. También sería un fallo degradar el desplazamiento o la edición normal del lienzo por mantener el chat abierto.

El análisis puede recomendar índices o alternativas de normalización, pero debe distinguir hipótesis de hechos. El esquema por sí solo no permite medir el rendimiento de consultas sin datos de ejecución.

## 4. Base existente y cambios necesarios

| Pieza existente                                             | Uso previsto                                                 | Extensión necesaria                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `src/collab/ops.js` y backend `src/collab/ops.ts`           | Diferencias y operaciones del documento                      | Mantener ambos contratos sincronizados; validar el conjunto antes de mutar                    |
| Backend `src/collab/validate.ts`                            | Validación estructural de lotes                              | Añadir validación de propiedades y coherencia del resultado para propuestas de IA             |
| `src/collab/ProjectSession.js`                              | Documento vigente, recepción remota y previsualización local | Distinguir vista previa histórica y propuesta de IA; detectar propuestas desactualizadas      |
| `src/collab/ProjectCollabProvider.jsx` y `CollabBridge.jsx` | Actualizar todos los contextos del documento                 | Exponer acciones para propuestas sin emitirlas como ediciones locales durante la vista previa |
| Backend `RoomManager`                                       | Documento vigente en memoria, versiones y difusión           | Incorporar confirmación atómica y comprobación de versión para IA                             |
| Historial y `ProjectSnapshot`                               | Conservar estados recuperables                               | Registrar estados previos a IA y atribución de la propuesta aplicada                          |
| Sesiones y `getRole`                                        | Autenticación y autorización                                 | Reutilizarlas en cada ruta y antes de cada aplicación                                         |

La infraestructura actual no garantiza por sí sola la atomicidad necesaria: `applyOps` puede devolver operaciones aplicadas aunque otra operación falle. El nuevo camino de confirmación debe evitar publicar ese resultado parcial.

## 5. Comportamiento del chat y la vista previa

El agente recibe el mensaje, contexto reciente acotado de la conversación, motor de base de datos y una representación del esquema vigente obtenida del servidor. El backend define las instrucciones y herramientas permitidas; no confía en roles ni instrucciones de sistema suministrados por el navegador.

La representación combina un catálogo compacto del proyecto con consultas de detalle bajo demanda. En proyectos grandes se recupera automáticamente el subgrafo relevante para la petición y sus dependencias; la selección manual de tablas es una ayuda opcional. La sección 10.1 define este comportamiento y sus presupuestos.

Antes de solicitar un cambio, el cliente envía las ediciones locales pendientes y espera sus confirmaciones. Así el contexto inicial corresponde al documento reconocido por el servidor. Una falla de sincronización impide generar o aceptar la propuesta hasta reconectar.

Una respuesta puede ser únicamente explicativa o contener una propuesta. Para proponer, el modelo usa un contrato estructurado que contiene explicación, advertencias y operaciones. Las herramientas solo consultan información autorizada o preparan una propuesta; ninguna confirma cambios.

La propuesta se ejecuta primero sobre una copia del documento base. El backend valida el documento resultante y calcula las diferencias que mostrará el cliente; el resumen verificable procede de esas diferencias, aunque se acompañe de una explicación del modelo.

La interfaz incorpora un acceso al asistente en el editor de proyectos y un panel lateral con selector de modelo, mensajes, estado de generación, cancelación y acciones de propuesta. El selector muestra el modelo que atenderá el próximo mensaje y se alimenta del catálogo dinámico de la sección 6.1. Los detalles visuales quedan a criterio del constructor, usando React, Semi UI y el sistema de traducciones existente.

Al elegir «Vista previa»:

- El editor muestra el documento propuesto en solo lectura local. Se mantiene el chat disponible para pedir ajustes.
- Se distinguen agregados y modificaciones mediante marcas y una leyenda; los elementos eliminados se identifican en el resumen y pueden localizarse en el estado anterior.
- Se puede alternar entre el estado anterior y el propuesto. El resumen detalla tablas, campos, relaciones y otros elementos afectados, incluidas eliminaciones.
- Las operaciones remotas siguen actualizando el documento vigente en segundo plano. La propuesta conserva su base original y se marca desactualizada si cambia la versión.
- «Volver al actual» sale de la vista previa sin aplicar ni descartar la propuesta. «Descartar» la invalida. Una nueva revisión sustituye a la propuesta pendiente anterior.
- Una vista previa de historial y una de IA son excluyentes. La barra y sus acciones distinguen claramente ambos orígenes.

Al aceptar, el usuario confirma el conjunto que ha previsualizado. Mientras se confirma, el botón evita solicitudes duplicadas. Si hay conflicto, el agente debe regenerar sobre el estado actual y solicitar una nueva revisión; no se fusiona automáticamente una propuesta obsoleta.

## 6. Proveedores y conexión con LiteLLM

El backend consume el endpoint compatible con Chat Completions de LiteLLM mediante un adaptador. Se reutilizan el endpoint y la credencial del proxy, copiándolos de forma segura a la configuración del despliegue. Los alias invocables se descubren a través del catálogo y se envía el elegido por el usuario. El servidor no lee `~/.cline` en producción ni el frontend recibe la credencial. Ningún secreto se incluye en el spec, comandos registrados o archivos versionados.

Configuración propuesta: `AI_ENABLED`, `LITELLM_BASE_URL`, `LITELLM_API_KEY` y `LITELLM_MODEL` como modelo predeterminado opcional; los límites de la sección 10 también son configurables. El valor predeterminado no reemplaza el catálogo ni obliga a todos los usuarios a usar el mismo modelo. Los cambios en los modelos publicados por LiteLLM se reflejan al actualizar el catálogo, sin modificar código o desplegar drawDB de nuevo.

«Compatible con proveedores» significa interoperar a través de LiteLLM con modelos cuyas capacidades hayan sido comprobadas. No se presupone soporte universal de herramientas, streaming o JSON Schema.

El adaptador admite un modo de herramientas nativas y otro de respuesta JSON estructurada, seleccionado según las capacidades verificadas del modelo elegido y la configuración del servidor. Ambos desembocan en la misma validación del servidor. No se envían parámetros incompatibles de forma indiscriminada ni se cambia de modelo o proveedor silenciosamente. Si el modelo solo permite conversación, el asistente puede explicar el esquema y muestra que las propuestas no están disponibles.

La prueba de capacidades de JSON y herramientas permanece pendiente: el intento dentro del sandbox no pudo acceder a la red y la repetición con acceso externo fue interrumpida. La implementación deberá verificar estas capacidades con mensajes sintéticos, sin datos privados del proyecto, antes de activar las propuestas.

### 6.1 Catálogo dinámico y selección de modelo

**La elección del modelo es una función del chat desde la primera versión.** El navegador consulta `GET /api/projects/:id/ai/models`; el backend verifica sesión y acceso al proyecto y consulta el endpoint de listado de LiteLLM con la misma credencial y destino configurados para las generaciones. La consulta ascendente es `GET /v1/models`, componiendo la URL sin duplicar `/v1` si ya forma parte de `LITELLM_BASE_URL`. Este mecanismo está documentado en [Model Discovery de LiteLLM](https://docs.litellm.ai/docs/proxy/model_discovery).

La lista visible es la intersección del catálogo anunciado al backend por LiteLLM, la política de acceso de drawDB si existe y los modelos aptos para conversación. No se consulta un inventario administrativo con una credencial más privilegiada. Se conservan los identificadores públicos o alias anunciados; no se inventan IDs a partir del proveedor o nombre comercial.

El contrato hacia el frontend devuelve únicamente campos permitidos: identificador, nombre visible, proveedor cuando sea conocido, capacidades conocidas de conversación/herramientas/JSON/streaming, ventana de contexto y salida cuando estén disponibles, y fecha/estado de actualización del catálogo. Nunca devuelve credenciales, rutas internas de despliegue ni la respuesta cruda de endpoints administrativos. Los metadatos ausentes se marcan como desconocidos, no como capacidades soportadas. El listado por sí solo no demuestra salud, cuota disponible ni soporte de propuestas.

Si el listado básico no incluye capacidades, el backend puede enriquecerlas con metadatos accesibles a la misma credencial o configuración explícita por alias. Los modelos de embeddings, imágenes u otras modalidades sin chat no se ofrecen como modelos conversacionales. Los alias cuya modalidad aún no se conoce requieren resolución de metadatos o configuración antes de habilitarlos; no se clasifican por una coincidencia informal de su nombre.

Comportamiento del selector:

- Al abrir el chat se carga o revalida el catálogo y se muestran estados de carga, lista vacía, error y reintento. Incluye búsqueda por nombre/identificador/proveedor y una acción «Actualizar modelos».
- Una conversación nueva puede sugerir la última elección válida del usuario; si no existe, el predeterminado del servidor solo se preselecciona si está en el catálogo permitido. Si no hay elección válida, se pide elegir. No se elige otro modelo automáticamente al fallar una petición.
- La selección se guarda en `AiConversation.selectedModel` y pertenece a esa conversación y usuario. Cambiarla no modifica la configuración global ni la elección de otro usuario. La última preferencia de usuario es solo una ayuda para conversaciones nuevas, no una restricción.
- El modelo puede cambiarse entre mensajes conservando la conversación. Mientras hay una generación activa, el selector queda bloqueado hasta que termine o se cancele. El backend fija el modelo al crear la generación para evitar carreras con cambios de selección posteriores.
- Cada respuesta y propuesta registra el alias solicitado y el modelo reportado por LiteLLM cuando exista, sin inventar la identidad subyacente de un alias. La interfaz identifica el modelo de cada respuesta al alternar modelos.
- Al cambiar de modelo se adapta el contexto reciente a sus capacidades y ventana. No se reproducen llamadas a herramientas o mensajes internos exclusivos de otro proveedor como si fueran un formato universal; se utiliza el historial canónico y los resultados validados relevantes.
- Cambiar la selección no descarta ni modifica una propuesta pendiente. Aceptarla no requiere volver a llamar al modelo; se aplican las validaciones y permisos de la sección 8. Pedir ajustes crea una nueva revisión con el modelo seleccionado para ese mensaje.
- Si el modelo seleccionado desaparece, se revoca o rechaza la generación, se conserva la selección para explicar el error, se actualiza el catálogo y se pide elegir uno disponible. El historial existente sigue siendo legible. No se reemplaza silenciosamente por el predeterminado.

El backend valida cada selección y solicitud de generación contra el catálogo permitido vigente y las políticas actuales; no acepta nombres arbitrarios, URLs, proveedores, claves ni parámetros de conexión enviados por el navegador. La caché se separa por configuración de conexión/credencial y alcance de política, con TTL inicial de 60 segundos, tamaño acotado y deduplicación de consultas simultáneas. Se invalida al cambiar configuración, credencial o política, y se refresca ante errores de modelo no disponible o autorización. Las revocaciones del proveedor siguen siendo autoritativas aunque el catálogo cacheado todavía muestre el alias.

«Actualizar modelos» fuerza una revalidación con límite de frecuencia. Si falla el refresco se puede mostrar la última lista como desactualizada, pero no se anuncia como consulta exitosa ni se habilita una selección no validada. La consulta tiene timeout y límite de tamaño de respuesta y no bloquea la edición del diagrama. No se consulta LiteLLM por cada tecla ni se generan completions de prueba para todos los modelos al abrir el selector.

La comprobación funcional pendiente incluye verificar el listado y el uso de al menos dos alias disponibles, cuando el despliegue los ofrezca. Si solo hay uno, el selector funciona con ese catálogo real; no se agregan opciones ficticias. Las capacidades de propuestas se verifican por alias antes de habilitarlas, mediante configuración o prueba controlada; una comprobación de texto de un modelo no habilita las propuestas de todos los demás.

## 7. Validación del documento propuesto

- Lista cerrada de operaciones y de propiedades editables por tipo de entidad; rechazo de claves desconocidas, prototipos, valores no finitos y estructuras excesivamente profundas.
- Identificadores únicos y referencias válidas entre tablas, campos, relaciones, índices, restricciones, vistas, tipos, enums y áreas. Reutilizar el comportamiento del editor para dependencias cuando exista.
- Tipos de datos y funcionalidades compatibles con el motor elegido, sin alterar el motor durante una propuesta.
- Identificadores de entidades existentes preservados. Los nuevos identificadores se asignan o normalizan en el servidor, con mapeo coherente de las referencias nuevas.
- Posiciones y dimensiones válidas para dibujar entidades nuevas. Se conservan las posiciones existentes salvo petición de reorganización.
- Una eliminación o renombrado debe actualizar las referencias estructuradas afectadas o rechazar la propuesta completa con una explicación.
- Dependencias en SQL libre u otro texto que no pueda reescribirse con garantías se señalan como bloqueo de esa propuesta. No se afirma que una sustitución textual actualiza correctamente SQL arbitrario.
- Si el documento base contiene problemas previos, se distinguen de los introducidos por la propuesta: se permite repararlos, pero no publicar un nuevo resultado incoherente.

Los nombres, comentarios, notas y demás contenido del proyecto son datos no confiables, no instrucciones que amplíen las capacidades del agente. Los mensajes del modelo se renderizan sin HTML ejecutable.

## 8. Confirmación, colaboración y recuperación

Cada propuesta pertenece a un usuario, proyecto y conversación y almacena `baseVersion` y una huella del documento base. La huella complementa la versión frente a recargas, restauraciones o reconstrucciones de sala. El backend usa el documento vigente del `RoomManager`, nunca solo el JSON persistido si hay cambios más recientes en memoria.

La confirmación sigue este contrato:

1. Verificar sesión, propietario de la propuesta, acceso al proyecto y rol editor o admin. Un viewer puede conversar y analizar; no puede generar ni aplicar propuestas de modificación.
2. Serializar la confirmación con las demás mutaciones y restauraciones del mismo proyecto. No se mantiene un bloqueo durante la llamada al modelo.
3. Comprobar que la propuesta sigue pendiente y no ha caducado, y que la versión y huella coinciden con el documento vigente. Un conflicto responde sin mutar el proyecto.
4. Revalidar todas las operaciones sobre una copia y validar su resultado completo.
5. Persistir, en una transacción, una copia previa recuperable, el documento resultante con su nueva versión y el estado aplicado de la propuesta. Se coordina con el guardado diferido existente para impedir que una escritura anterior sobrescriba la nueva versión.
6. Solo tras confirmar la transacción, actualizar el documento de la sala y difundir el lote como una edición remota también al cliente solicitante. La interfaz no vuelve a enviar ese lote como una edición local.

Si falla la transacción, no se cambia el documento de la sala ni se difunden operaciones. El nuevo método debe coordinar todas las entradas de escritura que puedan competir, incluidas restauraciones y el bucle de guardado, no únicamente dos solicitudes de IA. Mantener el despliegue de una sola instancia de colaboración actual; varias instancias exigirían coordinación adicional.

La confirmación es idempotente por identificador y revisión de propuesta: repetirla devuelve el resultado ya aplicado sin una segunda mutación. Si se pierde la respuesta o hay una desconexión tras persistir, el cliente consulta el estado y resincroniza el documento antes de mostrar el resultado.

La acción se registra con el usuario que la aceptó y su origen IA. Añadir un tipo de snapshot `pre_ai_apply` con retención de 30 días y una copia previa obligatoria por propuesta, sin limitarla con el cooldown de borrados masivos. Un fallo al guardar esa copia impide aplicar.

La recuperación inicial se ofrece mediante esa copia en el historial. Restaurarla afecta al proyecto completo y requiere la confirmación existente. No se introduce una inversa en la pila local de deshacer que pueda pisar trabajo posterior de otros colaboradores.

## 9. Persistencia y API

Propuesta de modelos nuevos, con relaciones y borrado en cascada a usuario/proyecto según corresponda:

| Entidad          | Contenido principal                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AiConversation` | Proyecto, usuario propietario, modelo seleccionado, fechas y título opcional                                                                                                                 |
| `AiMessage`      | Conversación, rol controlado por servidor, contenido, estado, modelo solicitado/reportado, uso reportado y fecha                                                                             |
| `AiProposal`     | Conversación, revisión, modelo solicitado/reportado, documento base, versión y huella, operaciones normalizadas, resumen, advertencias, estado, vencimiento, versión aplicada y copia previa |

Estados de propuesta: `pending`, `superseded`, `discarded`, `applied`, `expired`. La condición desactualizada se calcula comparando la base con el documento vigente. Solo una revisión pendiente puede confirmarse; ajustar crea una nueva revisión y sustituye a la anterior.

Rutas bajo `/api/projects/:id/ai`, con sesión y acceso comprobados en cada solicitud:

| Operación                               | Comportamiento                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects/:id/ai/models`       | Lista saneada de modelos permitidos y capacidades/estado de actualización                                                                             |
| Crear/listar conversaciones             | Solo las del usuario actual dentro del proyecto                                                                                                       |
| Cambiar modelo de conversación          | Validar catálogo permitido y propiedad; persistir selección sin alterar generaciones iniciadas                                                        |
| Leer mensajes y propuestas              | Propiedad de la conversación y paginación                                                                                                             |
| Enviar mensaje                          | Fijar modelo seleccionado; streaming cuando esté soportado, con respuesta completa como alternativa explícita; sin fragmentos de propuesta aplicables |
| Cancelar generación                     | Cancelación del trabajo propio y señal de aborto al proveedor cuando sea posible                                                                      |
| Leer estado y vista previa de propuesta | Resultado validado e información de base/conflicto                                                                                                    |
| Confirmar propuesta                     | Aceptación atómica e idempotente                                                                                                                      |
| Descartar propuesta                     | Invalidación sin cambios al proyecto                                                                                                                  |
| Eliminar conversación                   | Eliminar mensajes y contenido privado; conservar los snapshots ya creados en el historial del proyecto                                                |

El transporte puede ser fetch con eventos de streaming y un identificador de generación cancelable. El constructor fijará las rutas exactas y formato de eventos al planificar, manteniendo estos comportamientos. No hay generaciones simultáneas sobre una misma conversación.

Los datos de conversaciones inactivas y propuestas no aplicadas se eliminan tras 30 días de inactividad; vencimiento de propuesta pendiente de 24 horas. Las solicitudes pueden consultar el estado aplicado mientras se conserve la conversación. Las copias del historial tienen su propia retención.

## 10. Límites y operación

Valores iniciales propuestos, configurables:

- Una generación activa por usuario, con un máximo global inicial de cuatro; exceso rechazado de forma explícita sin cola ilimitada.
- Diez solicitudes de generación por minuto por usuario y treinta por proyecto.
- Mensajes de hasta 8.000 caracteres; contexto reciente de hasta 20 mensajes, además del esquema acotado.
- Contexto del esquema enviado al proveedor de hasta 200 KiB por llamada, acotado además por el presupuesto real de tokens del modelo. Este límite no restringe el tamaño del proyecto: se usan catálogo compacto y recuperación paginada automática según la sección 10.1, sin truncamiento silencioso. El resultado siempre se valida contra el documento completo.
- Hasta 500 operaciones por propuesta, conservando además los límites generales del documento del proyecto.
- Hasta 60 segundos por generación y un intento adicional para corregir una respuesta estructurada inválida, dentro del mismo presupuesto. Máximo inicial de doce rondas de herramientas de lectura/propuesta por generación, configurable y siempre acotado por tiempo y tokens. Las tareas globales que requieran más trabajo se dividen en etapas explícitas según la sección 10.1.

El backend acota la salida según el modelo configurado. Si la respuesta queda truncada no se publica una propuesta incompleta. Cancelar o cerrar el proyecto aborta la generación cuando sea posible; una respuesta tardía no reemplaza una propuesta más reciente.

Registrar identificadores de solicitud, modelo, duración, estado y consumo reportado. No registrar claves, encabezados de autorización ni contenido completo de esquemas o conversaciones. Si LiteLLM devuelve uso, mostrarlo sin inventar costos monetarios.

La credencial de LiteLLM se configura en el despliegue mediante secretos. Desactivar `AI_ENABLED` oculta el acceso y devuelve un error claro en rutas de IA sin afectar el editor.

### 10.1 Proyectos grandes: contexto, análisis y rendimiento

**Más de 200 entidades es un requisito de uso habitual, no un caso excepcional ni un máximo.** Para evitar ambigüedad, las mediciones separan tablas/vistas, campos, relaciones y otros elementos. La matriz de pruebas incluirá proyectos de 200, 500 y 1.000 tablas, más sus campos y dependencias. Es una matriz inicial de verificación, no un nuevo límite comercial o técnico de 1.000 entidades.

El constructor implementará:

- Un catálogo compacto con identificadores, nombres, tipos de entidad y relaciones principales, consultable por búsqueda y páginas. Si el catálogo completo tampoco cabe en el presupuesto, se pagina; no se omiten entidades como si no existieran.
- Herramientas de lectura para buscar entidades, obtener sus campos/índices y recorrer referencias entrantes y salientes. Un tamaño de página inicial de 25 entidades es configurable; las respuestas también se acotan por bytes y tokens, y devuelven cursor y cobertura explícitos. Una sola entidad demasiado grande se desglosa en campos y dependencias por páginas.
- Recuperación automática de entidades relevantes y expansión de sus dependencias. Se comprueba el alcance real de eliminaciones y renombrados contra el grafo completo del servidor, aunque el modelo solo haya visto una parte del esquema. Si es necesario ampliar el contexto, se consulta antes de preparar la propuesta.
- Presupuesto de contexto que incluya instrucciones, historial, catálogo/detalles, resultados de herramientas y reserva de salida, conforme al modelo configurado. Los 20 mensajes y 200 KiB son techos adicionales, no permiso para exceder la ventana del modelo. Si falta una capacidad o presupuesto conocido, se usa un valor conservador configurable y se informa de la limitación.
- Índices de búsqueda y referencias por proyecto y versión, calculados una vez por estado y actualizados o invalidados al cambiar el documento. No se recalculan en cada token del chat, movimiento del cursor, zoom o desplazamiento del lienzo. Las cachés tienen límites y se liberan al cerrar o expirar la sala.
- Validación y diferencias con índices por identificador, evitando búsquedas repetidas de todas las tablas para cada referencia. El objetivo es trabajo proporcional al número de entidades, campos y dependencias; se medirá cualquier excepción relevante.
- Cálculos de diferencias y preparación de vista previa fuera del camino de interacción del lienzo. Para trabajo que bloquee el hilo principal se usarán workers o fragmentación según la medición. Se reutilizan estructuras sin cambios y no se duplica el documento completo por mensaje o fragmento de streaming.
- Resumen de diferencias y mensajes extensos con paginación o virtualización; no se montan miles de filas del panel al abrir el chat. La previsualización conserva las optimizaciones existentes del lienzo.

Una petición de análisis global puede recorrer páginas o subgrafos en etapas con presupuesto y progreso explícitos. Cada etapa declara qué revisó y qué queda pendiente; no se presenta como análisis completo un resultado sobre un subconjunto. El recorrido se vincula a la misma versión del documento y se invalida o reinicia si cambia. Alcanzar un límite devuelve un punto de continuación y una explicación, sin bucles ilimitados ni exigir una selección manual como única salida.

Si una modificación global supera las 500 operaciones de una propuesta, se prepara un plan de varias propuestas dependientes, cada una con vista previa, confirmación y aplicación atómica propias. Las etapas posteriores se generan o revalidan sobre la versión resultante de la anterior. El plan no se anuncia como una única transacción y el usuario puede detenerse entre etapas sin perder la coherencia del documento.

## 11. Verificación de aceptación

- Conversar sobre un proyecto, recargar y recuperar únicamente la conversación del usuario autorizado.
- Consultar el catálogo a través del backend con la credencial de LiteLLM, seleccionar un modelo, recargar y conservarlo en esa conversación sin afectar otras conversaciones o usuarios.
- Simular incorporación/eliminación de alias, permisos revocados, lista vacía, timeout, caché desactualizada y refrescos simultáneos; rechazar modelos arbitrarios, excluir modalidades incompatibles y evitar la exposición de secretos o metadatos internos.
- Alternar entre dos modelos con capacidades y ventanas distintas: usar el seleccionado para el siguiente mensaje, registrar su procedencia, adaptar el contexto y conservar las propuestas pendientes. Rechazar cambios concurrentes de modelo durante una generación sin reiniciarla ni duplicarla.
- Comprobar que el listado no habilita propuestas automáticamente, que los modelos de solo conversación se identifican y que una caída no provoca cambio silencioso de modelo.
- Crear una propuesta válida y observar el diagrama y el resumen sin emitir operaciones a otros clientes ni cambiar el documento guardado.
- Pedir un ajuste: invalidar la revisión anterior y mantener coherentes la nueva vista previa y la revisión confirmable.
- Aplicar una propuesta: comprobar gráfico, estructura, DBML y exportaciones derivadas; no ejecutar cambios sobre bases externas. Los demás colaboradores reciben el mismo resultado una vez.
- Rechazar operaciones inválidas, referencias rotas y propuestas truncadas sin cambios parciales.
- Editar, restaurar o cambiar permisos mientras se genera/previsualiza: rechazar la confirmación obsoleta o no autorizada y conservar el trabajo vigente.
- Simular confirmaciones duplicadas, fallos de persistencia, guardados diferidos y reconexiones: una aplicación como máximo, copia previa obligatoria y resincronización correcta.
- Verificar aislamiento entre usuarios y proyectos, límites, cancelación y renderizado de contenido no confiable.
- Verificar ambos modos del adaptador con respuestas simuladas y comprobar con el LiteLLM configurado las capacidades realmente habilitadas. Una conexión textual exitosa no sustituye esta prueba.
- Comprobar que abrir el chat y mostrar una propuesta no degrada la interacción normal del lienzo; cargar el documento de vista previa solo al solicitarlo y memorizar los cálculos de diferencias.
- Ejecutar casos con 200, 500 y 1.000 tablas, campos abundantes y relaciones tanto dispersas como densas: búsqueda automática, contexto paginado, renombrado/eliminación con dependencias fuera del contexto, propuesta y retorno al estado actual.
- Incluir documentos de más de 200 KiB y catálogos o entidades individuales que excedan una página; comprobar que no se rechaza el proyecto por su tamaño, no se omiten referencias y no se rebasa el presupuesto de contexto.
- Comprobar la continuación de análisis global y planes de múltiples propuestas al agotar tiempo, tokens u operaciones, incluidas las invalidaciones por cambios de versión.
- Registrar entorno y características del fixture, tiempos de preparación de contexto, validación y diferencias, memoria máxima y latencia de interacción del lienzo. Comparar contra el mismo fixture sin el asistente y con respuestas de proveedor simuladas. El plan fijará los umbrales de aceptación a partir de esa línea base antes de implementar y no dará por demostrada la escalabilidad solo por usar paginación.
- Ejecutar tests pertinentes, lint y build en ambos repositorios al integrar. Las pruebas automáticas habituales no consumen el proveedor real.
- Completar y documentar la auditoría final con `security-audit` descrita en la sección 13.

## 12. Desarrollo obligatorio con Cline y tareas en paralelo

**Requisito del usuario: usar Cline CLI para ejecutar en paralelo las tareas de desarrollo de esta funcionalidad.** Las invocaciones usarán la conexión LiteLLM ya configurada. No basta con mencionar Cline en el plan o ejecutar una prueba de conectividad: debe realizar trabajo de desarrollo independiente y verificable.

Después de aprobar este diseño se redacta el plan de implementación y se fijan primero los contratos compartidos: documento, operaciones/propuestas, API, eventos y estados de vista previa. Con esos contratos, el responsable inicia sesiones independientes de Cline que se ejecutan concurrentemente. No se paralelizan trabajos que dependan de un contrato todavía cambiante.

División inicial propuesta:

| Tarea de Cline     | Trabajo asignado                                                                                                                                    | Dependencia                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Backend            | Adaptador LiteLLM, catálogo dinámico y validación de selección, conversaciones/propuestas, autorización y pruebas del servicio                      | Contratos definidos                  |
| Frontend           | Chat, selector y actualización de modelos, cliente de API, vista previa, estados e integración con el editor, usando respuestas simuladas al inicio | Los mismos contratos definidos       |
| Revisión posterior | Revisar cambios integrados, contratos entre repos y casos de colaboración/recuperación                                                              | Las dos tareas anteriores terminadas |

Empezar con dos sesiones de desarrollo concurrentes; aumentar solo si el plan identifica tareas realmente independientes y existe capacidad del proveedor. La revisión final y la integración dependen de las tareas anteriores, por lo que se ejecutan después.

Cada sesión tiene un worktree o checkout aislado y una rama propia, incluso cuando sus archivos pertenezcan a repositorios diferentes. Se le entregan el spec, tarea concreta, contratos, archivos permitidos, verificaciones esperadas y límites de alcance. No se lanzan procesos que escriban concurrentemente sobre el mismo checkout, la misma rama, archivos compartidos de configuración o una base de datos de pruebas común.

Cada sesión usa estado local de Cline separado cuando la CLI lo requiera, sin alterar el perfil compartido ni copiar secretos al repositorio. Las credenciales se proveen mediante el mecanismo seguro de configuración existente. Nunca se pasan API keys como argumentos visibles o se escriben en prompts y logs de tareas.

Las sesiones respetan los permisos y el sandbox del entorno; no se usa `--yolo` ni se habilitan aprobaciones automáticas generales. No publican, despliegan, fusionan ni modifican servicios reales. Si una acción requiere autorización fuera de la ya concedida, el coordinador la gestiona antes de ejecutar la acción dependiente.

El coordinador monitoriza resultados, resuelve dependencias y revisa las diferencias de cada sesión. Para fallos de una tarea, continúa la sesión correspondiente con el contexto del fallo. Integra los cambios secuencialmente y verifica la combinación final en ambos repositorios. La salida exitosa de Cline no sustituye la revisión del código y las pruebas.

La entrega incluye un registro breve de las tareas ejecutadas por Cline, su concurrencia, cambios producidos y verificaciones. No se cambia de herramienta silenciosamente si Cline o el proveedor no permiten ejecutar una tarea: se informa y se ajusta el plan.

La integración funcional y las pruebas de escala preceden a la auditoría final de seguridad. Esta última es una tarea obligatoria del plan; no se sustituye por la revisión general realizada por Cline.

## 13. Auditoría de seguridad obligatoria al finalizar

**Requisito del usuario: al finalizar la implementación, ejecutar una auditoría de seguridad de lo implementado con la habilidad [`security-audit`](/home/carlos/.agents/skills/security-audit/SKILL.md).** Ahora se documenta esta obligación; la auditoría se ejecutará sobre el código implementado e integrado de ambos repositorios.

El plan incluirá una auditoría en modo completo, perfil `standard`, con alcance delimitado a la funcionalidad del agente y a los caminos existentes que modifica o utiliza para atravesar una frontera de confianza. Se registran las revisiones base/final de frontend y backend y los cambios sin commit presentes al revisar. El resto de la aplicación se declara fuera de alcance; no se afirma que toda drawDB haya sido auditada.

El alcance mínimo comprende:

- Autenticación, permisos de editor/viewer/admin, propiedad de conversaciones/propuestas y aislamiento entre usuarios y proyectos, incluidos streaming, cancelación y lectura de vistas previas.
- Instrucciones maliciosas en mensajes o contenido del esquema, autorización de herramientas, validación del contenido generado y límites entre datos y operaciones ejecutables.
- Filtración de secretos o esquemas en frontend, logs, errores y configuración; selección de proveedor, endpoint y destino de solicitudes sin control arbitrario por el usuario.
- Autorización y saneamiento del catálogo de modelos, aislamiento de cachés, validación del alias seleccionado, revocaciones y prevención de selección de modelos fuera de política o de destinos arbitrarios.
- Renderizado de contenido del modelo y del proyecto, y operaciones malformadas o capaces de alterar propiedades fuera de la lista permitida.
- Confirmaciones duplicadas o concurrentes, revocación de acceso, conflictos de versión, persistencia, difusión colaborativa y recuperación mediante snapshots.
- Límites de recursos de contexto, páginas, operaciones, generaciones, cachés y streaming en proyectos de más de 200 entidades; pruebas de abuso siempre locales y acotadas.
- Migraciones, configuración, dependencias nuevas o modificadas y límites de escritura/credenciales de las tareas de Cline introducidas por esta implementación.

La auditoría seguirá las seis fases de la habilidad: reconocimiento, búsqueda guiada por cobertura, validación de candidatos, salida estructurada, verificación independiente y reporte. Debe usar pruebas basadas en código y resultados mínimos reproducibles; únicamente los hallazgos confirmados reciben severidad. Los hechos externos no comprobables se registran como `needs_validation` con el bloqueo concreto, sin inventar vulnerabilidades ni garantías.

Las pruebas dinámicas de auditoría usan identidades y secretos ficticios, proveedor simulado y sandbox con aislamiento de red, entorno explícito vacío salvo valores permitidos, fuente/herramientas en solo lectura, escritura solo en scratch asignado y límites de CPU, memoria, procesos, disco y tiempo. No se prueban servicios desplegados ni se consume cuota de LiteLLM durante la auditoría. La prueba funcional del proveedor descrita en la sección 6 es una actividad separada. Si faltan controles de ejecución, se continúa con revisión estática y se documentan las validaciones bloqueadas.

Los artefactos de auditoría se guardan en un directorio nuevo autorizado fuera de ambos repositorios, resuelto al iniciar la auditoría conforme a la habilidad; no se crea ahora ni se utiliza `/tmp` como alternativa. Se registran como mínimo `run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md` y `NEEDS-VALIDATION.md`, con los validadores de hallazgos y cobertura aprobados. Cada agente tiene scratch separado y el coordinador conserva la propiedad exclusiva de los reportes y artefactos retenidos.

La auditoría inspecciona la fuente sin modificarla. Los hallazgos confirmados se corrigen después en tareas de desarrollo separadas y se vuelve a verificar el código corregido. La entrega enlaza el informe, la cobertura efectiva, los hallazgos corregidos y los bloqueos pendientes. Si la auditoría no puede completar su flujo, se registra `run_status: incomplete` y la causa exacta; no se declara cerrada la auditoría ni validada la seguridad de la funcionalidad.

## 14. Criterio del constructor

Quedan a criterio del constructor la distribución concreta de módulos, detalles visuales del panel, nombres finales de rutas y eventos, pruebas representativas y estructura de los prompts. Debe mantener la arquitectura y garantías descritas, apoyarse en el sistema existente y documentar cualquier cambio de alcance.

Antes de habilitar propuestas en el despliegue se completará la prueba de capacidades pendiente. La implementación incluye migraciones y configuración de ambos repositorios; el despliegue a un servicio real requiere su autorización correspondiente.
