-- 005_intentos_login.sql — limite de intentos de acceso al panel (fase 7).
--
-- El panel se abre con una sola clave compartida y hasta ahora se podia
-- intentar sin limite. Una clave que una persona eligio y escribe de memoria no
-- resiste adivinanza ilimitada: el limite no es un lujo, es lo que hace que la
-- clave valga algo.
--
-- Lo que se guarda es una huella del origen, nunca la IP. Una IP es un dato
-- personal y este repositorio es publico (invariante 12). La huella es un HMAC
-- con el secreto de sesion, no un SHA a secas: el espacio de direcciones IPv4
-- es chico y un hash sin llave se invierte con una tabla, asi que sin el
-- secreto la columna no dice de quien es.
CREATE TABLE intentos_login (
  huella TEXT PRIMARY KEY,
  intentos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TEXT,
  primer_intento_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- El barrido de mantenimiento borra lo viejo por aca.
CREATE INDEX ix_intentos_login_actualizado ON intentos_login (actualizado_en);
