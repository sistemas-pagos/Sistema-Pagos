-- 005_contexto_recordado.sql — para no recordarle dos veces lo mismo al vecino.
--
-- Cuando el contexto vence sin respuesta se le manda un solo recordatorio. Sin
-- una marca de que ya se mando, cada corrida del worker —cada diez minutos—
-- volveria a mandarlo, y el vecino recibiria el mismo mensaje seis veces por
-- hora hasta que conteste. Eso no es insistir: es acoso.
--
-- ADD COLUMN sobre una columna nula: no reescribe la tabla ni toca una fila.
ALTER TABLE contextos ADD COLUMN recordado_en TEXT;
