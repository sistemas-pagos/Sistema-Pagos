-- 002_mensaje_cuerpo.sql — guarda el texto de los mensajes hasta procesarlos.
--
-- El webhook responde 200 sin interpretar nada y el trabajo pesado corre despues
-- en Actions (docs/PLAN.md, seccion 2), asi que el cuerpo del mensaje tiene que
-- sobrevivir entre las dos etapas. Es donde llega la respuesta con Etapa, Bloque
-- y Casa.
--
-- Se borra al cerrar el mensaje, igual que media_id: el dato vive lo que dura el
-- procesamiento y nada mas (invariante 11).
ALTER TABLE mensajes ADD COLUMN cuerpo TEXT;
